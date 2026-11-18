# Code Context Round text limits

A coding agent pulls a Round with Doable MCP `get_code_context_round` and gives the response to the helper's
`record-round`. The helper refuses a response whose text is longer than the bounds below, and the Round then cannot
be answered on that machine. Doable's server sets no maximum on any of these texts, so the two sides can drift apart:
read this page before a change on either side.

## The bounds

| Text | Helper bound (characters) | What Doable sends (2026-11-18) | Doable's maximum |
| --- | --- | --- | --- |
| `questions[].answer_requirements` | 20,000 | 4,296 at the longest (see below) | none |
| `questions[].question`, `established_context[].question` | 4,000 | the base question: 184 plus the person's request; a chat request: the person's message | none |
| `questions[].why` | 2,000 | 148 on the base question; a planned question's own reason | none |
| `feature_scope` | 2,000 | the person's request | none |
| `situation`, `journey_map.how`, `journey_map.may_skip` | not bounded | 204, 930 and 216 at the longest | none |

The bounds are `ROUND_TEXT_LIMITS` in `plugins/doable-code-context/scripts/doable-code-context.mjs`. They only stop a
malformed response; they are not part of what Doable may ask.

Answer requirements Doable sends today, measured from pull responses built by the server's own code:

| Round | `answer_requirements` |
| --- | --- |
| First test spec, smoke (base question) | 3,059 |
| First test spec, deeper (base question) | 3,576 |
| Follow-up baseline (base question) | 3,631 |
| Chat v2 first pass (base question) | 4,296 |
| Chat request follow-up | 1,927 |
| Chat v2 quick round | 1,722 |

## History

The bound on answer requirements was 3,000 characters from the first release through 0.3.0. The base question's
requirements passed it for deeper rounds on 2026-10-21 and for every base question on 2026-11-10, and `record-round`
refused those Rounds with `questions[0] answer requirements must be 0-3000 characters`. Only request rounds still
passed. 0.3.1 raises the bound to 20,000.

## Before a change on Doable's server

- A helper on a customer's machine keeps its bound until the customer updates the plugin. Plugin versions up to 0.3.0
  refuse answer requirements over 3,000 characters whatever this repository holds now.
- When a text in the table grows, compare the new length with the bound. When it passes half of the bound, raise the
  bound here first and release the plugin before the server change.
- Update the numbers on this page and `ANSWER_REQUIREMENTS_SENT_TODAY` in
  `tests/doable-code-context-helper.test.mjs`.

## Before a change to the helper

- Keep the bound on answer requirements at least twice the longest text Doable sends. The test
  "record-round accepts the answer requirements Doable sends, with room to grow" fails otherwise, and it checks that
  this page states the same numbers.
- Do not add a bound to `situation` or the journey-map instructions: the helper never refuses a Round over them.

## Known gap

`feature_scope` and the base question hold the person's own request, which Doable does not bound. `record-round`
refuses a Round whose request is longer than 2,000 characters (`round feature scope must be 1-2000 characters`), and a
chat request whose message is longer than 4,000 characters (`questions[0] question must be 1-4000 characters`).
