# session-watch

A Claude Code mod that keeps a **Sessions** pane beside the chat with a summary of every Claude Code session running on the same machine with Remote Control on. On a timer it reads each session's latest turn, asks Claude Haiku whether the session is waiting on you, and marks the ones that are with an orange dot. A click on a row opens that session on claude.ai with Remote Control.

The question and the summary of each session are written in the language of that session's latest message.

## Install

At the prompt of a terminal session:

```
/plugin install session-watch --marketplace infotrend/claude-mods
```

From a shell:

```bash
claude plugin install session-watch --marketplace infotrend/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `infotrend/claude-mods`, then **Add plugin**.

Every session that loads the mod runs its own scan and its own Haiku calls. To have it in one session only, install it with `--scope local` from the folder where you start that session, instead of the default user scope.

## Requirements

- Linux: the scanner checks that a session's process is alive through `/proc`.
- `python3` on the machine where Claude Code runs.
- The sessions to watch have Remote Control on; the others are left out.

## Use

- **Every N min**: how often the pane refreshes (1, 2, 3, 5, 10, 15, 30 or 60 minutes; the mobile app steps through them with a button). While the timer runs, a countdown to the next refresh shows beside the session count.
- **Stop / Start**: stops or starts the timer.
- **Refresh**: refreshes now.
- `/session-watch` opens the pane; `/session-watch start`, `stop` or `now` act as the buttons; `/session-watch <minutes>` (1 to 120) sets the period.

Sessions waiting on you come first, then the ones working, then the idle ones. A session whose turn has ended while a command or a subagent it started still runs shows as **working in background**. Background commands older than 3 hours are taken for a server or a stale watcher and do not count. The status line shows how many sessions have a question. Verdicts are cached by the content of each session's latest turn, so an unchanged session is not sent to the model again.

## Development

`claude plugin validate .` checks the manifest and the hooks module; `claude plugin test .` runs the tests in `tests/`.
