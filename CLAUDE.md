# Claude Code Configuration - RuFlo V3

## ⚡ PRIMARY DIRECTIVE — Orchestrator Mode (token economy)

**Claude (the main session) is the BRAIN/ORCHESTRATOR ONLY.** All actual work
— file reads, edits, code generation, searches, multi-step research, builds,
tests — is delegated to spawned subagents via the Task tool. The main session
plans, briefs, integrates results, and decides next steps.

**Workflow:**
1. Receive user request → analyse what's needed
2. Decompose into delegable subtasks
3. Spawn the right specialist agents IN PARALLEL via the Task tool, all in
   ONE message, with `run_in_background: true` where appropriate
4. Each agent gets a self-contained brief: goal, context, file paths, output format
5. Wait for agents to return — do NOT poll, do NOT add intermediate work
6. Integrate the agent reports, decide next step, communicate to user

**When direct tool calls ARE allowed (token-economy exceptions):**
- Reading a single small file the user explicitly named
- Trivial one-line edits where briefing an agent costs more than the edit
- Showing the user a result (no work, just communication)
- Spawning the agents themselves (the Task tool calls)

**When direct tool calls are FORBIDDEN:**
- Multi-file reads — delegate to Explore agent
- Implementation work spanning >1 file — delegate to coder agent
- Code review — delegate to code-reviewer / security-reviewer
- Test writing — delegate to tdd-guide
- Build error fixes — delegate to *-build-resolver
- Cross-cutting refactors — delegate to refactor-cleaner / architect
- Doc updates — delegate to doc-updater
- E2E test runs — delegate to e2e-runner

**Available specialist agents** (see `agents/*.yaml` for AlgoTrade-tuned configs):
coder, architect, tester, reviewer, security-architect (custom).
Built-in: planner, tdd-guide, code-reviewer, security-reviewer, refactor-cleaner,
doc-updater, build-error-resolver, e2e-runner, master-coder, Explore, Plan,
typescript-reviewer, python-reviewer, etc.

**Briefing format** (every spawned agent prompt):
- Goal: what success looks like
- Context: relevant background, what's been tried/ruled out
- Inputs: file paths, line numbers, exact identifiers
- Output: what to report back, length cap if needed

**Anti-patterns to avoid:**
- Doing the work yourself "because it's faster" — false economy on tokens
- Sequential agent calls — always parallel in one message unless dependent
- Polling agent status — trust them to return
- Verbose briefs that re-derive context the agent could find itself

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

### Project Config

- **Topology**: mesh
- **Max Agents**: 5
- **Memory**: memory
- **HNSW**: Disabled
- **Neural**: Disabled

## Build & Test

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- Run `npx @claude-flow/cli@latest security scan` after security-related changes

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message

## Swarm Configuration & Anti-Drift

- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use `raft` consensus for hive-mind (leader maintains authoritative state)
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

## Swarm Execution Rules

- ALWAYS use `run_in_background: true` for all agent Task calls
- ALWAYS put ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT add more tool calls or check status
- Never poll TaskOutput or check swarm status — trust agents to return
- When agent results arrive, review ALL results before proceeding

## V3 CLI Commands

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization |
| `agent` | 8 | Agent lifecycle management |
| `swarm` | 6 | Multi-agent swarm coordination |
| `memory` | 11 | AgentDB memory with HNSW search |
| `task` | 6 | Task creation and lifecycle |
| `session` | 7 | Session state management |
| `hooks` | 17 | Self-learning hooks + 12 workers |
| `hive-mind` | 6 | Byzantine fault-tolerant consensus |

### Quick CLI Examples

```bash
npx @claude-flow/cli@latest init --wizard
npx @claude-flow/cli@latest agent spawn -t coder --name my-coder
npx @claude-flow/cli@latest swarm init --v3-mode
npx @claude-flow/cli@latest memory search --query "authentication patterns"
npx @claude-flow/cli@latest doctor --fix
```

## Quick Setup

```bash
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
npx @claude-flow/cli@latest daemon start
npx @claude-flow/cli@latest doctor --fix
```

## Claude Code vs CLI Tools

- Claude Code's Task tool handles ALL execution: agents, file ops, code generation, git
- CLI tools handle coordination via Bash: swarm init, memory, hooks, routing
- NEVER use CLI tools as a substitute for Task tool agents

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
