# Contributing to WasmEdge Agent

WasmEdge Agent is developed in public at [second-state/wasmedge-agent](https://github.com/second-state/wasmedge-agent). Bug reports, feature requests, questions, and pull requests are welcome.

## Issues

Open an [issue](https://github.com/second-state/wasmedge-agent/issues) for bugs and feature requests. Search existing issues first. Include enough detail to reproduce the problem: the version or commit, the platform, and the steps. Do not share API keys, tokens, private prompts, or other sensitive information.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting publicly.

## Pull Requests

1. Keep each change focused on one concern.
2. Follow [AGENTS.md](AGENTS.md) and the existing conventions. Design decisions live in [DESIGN.md](DESIGN.md).
3. Add or update tests for behavioral changes.
4. Run `npm run check` and the relevant tests, and describe the validation in the pull request.
5. Add a line to the `[Unreleased]` section of each touched package's `CHANGELOG.md`.

You are responsible for the code you submit, including agent-generated code, and must understand how it interacts with the rest of the project.

Development setup and commands are documented in the [development guide](packages/coding-agent/docs/development.md).
