import { useEffect, useState } from 'react';
import { api, type RunSummary, type StageInfo, type SystemStatus } from './lib/api';
import { useAsync, useHashRoute, usePoll } from './lib/hooks';
import { TopBar } from './components/TopBar';
import { RunDialog } from './components/RunDialog';
import { ToastHost, useToast } from './components/Toast';
import { HomeScreen } from './screens/HomeScreen';
import { RunScreen } from './screens/RunScreen';
import { SetupScreen } from './screens/SetupScreen';

/**
 * Three screens: what has been made, one run in detail, and setup.
 *
 * Everything that used to require a terminal now has a home in one of them. The app polls
 * for the two facts that are not part of any single run's event stream — whether a run is
 * active at all, and whether this machine can do a live one — and hands them down.
 */
export default function App() {
  return (
    <ToastHost>
      <Shell />
    </ToastHost>
  );
}

function Shell() {
  const toast = useToast();
  const [route, navigate] = useHashRoute();
  const [showNewRun, setShowNewRun] = useState(false);

  const { data: runsData, reload: reloadRuns } = usePoll(() => api.runs(), 5000, []);
  const { data: system, reload: reloadSystem } = usePoll(() => api.system(), 20000, []);
  const { data: stages } = useAsync<StageInfo[]>(() => api.stages(), []);

  const runs: RunSummary[] = runsData?.runs ?? [];
  const active = runsData?.active ?? null;

  // Opening straight onto a run in progress is almost always what someone wants, but only
  // on a cold start — never yanking them out of a screen they chose.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (landed || !runsData) return;
    setLanded(true);
    if (route.name !== 'home') return;
    const waiting = runs.find((r) => r.status === 'awaiting_human');
    const target = active?.run_id ?? waiting?.run_id;
    if (target && !window.location.hash) navigate({ name: 'run', runId: target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsData]);

  async function stopRun(runId: string) {
    try {
      await api.stopRun(runId);
      toast('Stopping after the current step finishes writing.', 'info');
      reloadRuns();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        route={route}
        runs={runs}
        active={active}
        system={system as SystemStatus | null}
        onNavigate={navigate}
        onNewRun={() => setShowNewRun(true)}
      />

      {/* Each screen owns its own scrolling: the run screen keeps its rail and event
          drawer fixed while only the panel scrolls, which a page-level scroller breaks. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {route.name === 'home' && (
          <div className="scrollbar-thin h-full overflow-y-auto">
          <HomeScreen
            runs={runs}
            active={active}
            system={system as SystemStatus | null}
            onNewRun={() => setShowNewRun(true)}
            onOpenRun={(runId) => navigate({ name: 'run', runId })}
            onStop={stopRun}
            onSetup={() => navigate({ name: 'setup' })}
          />
          </div>
        )}

        {route.name === 'run' && (
          <div className="h-full">
            <RunScreen
              key={route.runId}
              runId={route.runId}
              routeStageId={route.stageId}
              onSelectStage={(stageId) => navigate({ name: 'run', runId: route.runId, stageId })}
              runs={runs}
              system={system as SystemStatus | null}
              stages={stages ?? []}
              onBack={() => navigate({ name: 'home' })}
              onOpenRun={(runId) => navigate({ name: 'run', runId })}
              onRunsChanged={reloadRuns}
            />
          </div>
        )}

        {route.name === 'setup' && (
          <div className="scrollbar-thin h-full overflow-y-auto">
            <SetupScreen
              system={system as SystemStatus | null}
              onReloadSystem={reloadSystem}
              onBack={() => navigate({ name: 'home' })}
            />
          </div>
        )}
      </div>

      {showNewRun && (
        <RunDialog
          system={system as SystemStatus | null}
          stages={stages ?? []}
          onClose={() => setShowNewRun(false)}
          onStarted={(runId) => {
            setShowNewRun(false);
            reloadRuns();
            navigate({ name: 'run', runId });
          }}
        />
      )}
    </div>
  );
}
