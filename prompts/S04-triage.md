# S4 — Political triage

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Keep the stories that are genuinely **political**, identify who is in them, and flag the
legal exposure early — before anyone spends effort designing a cartoon that can never run.

## Your input

`{{input_artifacts}}`. No network for this stage.

## What counts as political

Coalition and opposition manoeuvring · Knesset business · judicial and
attorney-general matters · security and defence **policy** (not operational reporting) ·
budget and economic policy · religion-and-state · local government · elections ·
corruption and ethics · foreign policy · civil rights and rule-of-law questions.

What does not: crime reporting without a policy dimension, sport, culture, weather,
business results with no policy angle, and human-interest stories.

## The public-figure test — do this carefully

For every named person, decide whether they are a **public figure acting in a public
capacity**, and record the `basis` — the office they hold, the public act they took.

- A minister, MK, mayor, party leader, senior official acting officially: yes.
- A politician's spouse, child, or a private citizen who happens to appear in the story: **no.**
- A civil servant named in passing without decision-making authority: usually no.

A story whose only targets fail this test is dropped with reason `private_individual`. This
is not a preference; §2.5 of the editorial policy makes it a hard block, and catching it
here saves four stages of wasted work.

## Legal flags

- **`censor_risk`** — Israel operates prior military censorship over defined security
  matters. Set `likely` where the story turns on operational security detail, intelligence,
  or matters plainly within censor scope; `possible` where adjacent; `none` otherwise. Be
  conservative: over-flagging costs a human glance, under-flagging costs a publication
  incident.
- **`sub_judice`** — true where there are active criminal or judicial proceedings that
  constrain comment on guilt or outcome.

## Salience

Score 0-10 for how much this story is actually driving the national conversation right now.
Use the evidence you have — outlet breadth, engagement totals, recency, whether coverage is
accelerating or decaying. This is a first-pass filter, not the caricature rubric; S5 does
that with far more care.

Keep the top **25** by salience.

## Definition of done

`{{artifact_name}}` exists, validates, and every input story appears in exactly one of
`kept` or `dropped`. Nothing vanishes silently.

## Output contract

```json
{{contract_json}}
```
