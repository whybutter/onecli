# Contributing to OneCLI

Thank you for your interest in contributing to OneCLI! We'd love to have you contribute. Here are some resources and guidance to help you get started.

- [Getting Started](#getting-started)
- [Issues](#issues)
- [Pull Requests](#pull-requests)
- [License](#license)

## Getting Started

To ensure a positive and inclusive environment, please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

### Local Development Setup

```bash
git clone https://github.com/onecli/onecli.git
cd onecli
pnpm install
pnpm dev
```

`pnpm dev` sets everything else up on first run: it creates `.env` with
generated secrets, starts PostgreSQL, applies migrations, and generates the
Prisma client. No values to copy, nothing to fill in.

See the [README](README.md) for more details on prerequisites and configuration.

## Issues

If you find a bug, please create an issue and we'll triage it.

- Please search [existing issues](https://github.com/onecli/onecli/issues) before creating a new one.
- Please include a clear description of the problem along with steps to reproduce it. Screenshots and URLs really help.

## Pull Requests

We actively welcome your Pull Requests! A couple of things to keep in mind before you submit:

- If you're fixing an issue, make sure someone else hasn't already created a PR fixing the same issue. Link your PR to the related issue(s).
- If you're new, we encourage you to take a look at issues tagged with [good first issue](https://github.com/onecli/onecli/labels/good%20first%20issue).
- If you're submitting a new feature, please open an [issue](https://github.com/onecli/onecli/issues/new) first to discuss it before opening a PR.

Before submitting your PR, please run these checks locally:

```bash
pnpm build     # Ensure the project builds
pnpm check     # Lint + types + format
```

Running these before you create the PR will help reduce back and forth during review.

## License

This project is licensed under the [Apache License 2.0](LICENSE). By
contributing, you agree that your contributions will be licensed under the
Apache License 2.0 as well.

If you do not agree with these terms, you must not contribute your work to this
repository.
