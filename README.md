# Token Watcher

A Claude Code mod that counts the tokens your sessions use against a budget you set, and warns you before it runs out.

- **Status line** under the prompt in every session: `Tokens 12.4M / 50M · 75% left · renews in 12d`
- **`/tokens`** opens a pane with the figures: spent, remaining, renewal date, the last 7 days, today, this session, the pace and when the budget would run out, a breakdown by token kind, and Claude's own 5-hour and 7-day account limits
- **Settings view** in the same pane: the limit, monthly or weekly renewal, what counts, and the warning thresholds
- **Warning at 20% left**: one toast, and a line above the prompt you can hide
- **Sticky warning at 5% left**: a line above the prompt that stays until the budget renews or you raise the limit

It never blocks a prompt. It only tells you where you stand.

## Install

No build step and no dependencies. Pick one.

**From a copy of this folder** (cloned, or copied from another PC):

```
claude plugin install token-watcher --marketplace /path/to/claude-mods-token-watcher
```

**From GitHub** (recommended):

```
claude plugin install token-watcher --marketplace sayemPasha/claude-mods-token-watcher
```

The same line works at the prompt of a terminal session as `/plugin install token-watcher --marketplace sayemPasha/claude-mods-token-watcher`. To get a newer version later, run `claude plugin update token-watcher`. In the desktop app: click + next to the prompt box, then Plugins, Add marketplace, then Add plugin.

**Without installing**, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods-token-watcher" } }
```

Several folders are separated with `:` (`;` on Windows).

Choose the user scope when asked, and the mod is on in every session started after that.

## First use

1. Type `/tokens limit 50M` (or `2.5M`, `500k`, `1200000`), or open `/tokens settings` and fill in the limit. Or press **Pro $20** or **Max $100** in settings: it fills in a rough weekly budget for that plan (4M or 20M tokens a week, counting all except cache reads), estimated for Opus at medium effort. Sonnet goes about twice as far, Fable about half.
2. Set the renewal: monthly on a day of the month (a shorter month renews on its last day), or weekly from a weekday.

| Command | What it does |
| --- | --- |
| `/tokens` | Opens the pane on the usage view |
| `/tokens settings` | Opens the pane on the settings view |
| `/tokens limit 50M` | Sets the limit without opening anything |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Max tokens per cycle | not set | Until it is set, the mod shows spend only and never warns |
| Renews | every month, day 1 | Or every week, from the weekday you choose |
| What counts | all except cache reads | Also: all tokens, or input + output only |
| Warn at | 20% left | A toast once per cycle, and a line you can hide |
| Keep the warning up at | 5% left | The line stays and cannot be hidden |

**About "what counts".** Cache reads are tokens Claude re-reads from its prompt cache on every request. They are usually many times larger than everything else and are billed at a fraction of the price, so they are left out by default. The pane's breakdown always shows all four kinds, so you can see what each choice would count.

## What it can and cannot know

- It counts Claude Code sessions **on this PC**, from the day the mod was installed, including subagents.
- It does not see usage on claude.ai, on other devices, or from before it was installed. For the whole account, read the "Claude account limits" section of the pane: those percentages come from Claude itself.
- Each PC keeps its own count and its own settings. To carry the settings to another PC, press **Copy settings** in the settings view, then paste the text into **Paste settings** there.

The count and the settings are kept in the mod's own store under your Claude Code configuration folder. Nothing is sent anywhere.

## Developing

```
claude plugin validate .   # the manifest, the marketplace file and the hooks module
claude plugin test .       # tests/watcher.test.tsx
```

- `hooks/lib.ts`: the arithmetic (cycles, counting, wording), with no engine calls
- `hooks/register.tsx`: the hooks, the pane and the warning line
- `types/index.d.ts`: the settings, the ledger and the state contract

After an edit, `/reload-plugins` in a running session picks it up when the mod was installed from this folder.
