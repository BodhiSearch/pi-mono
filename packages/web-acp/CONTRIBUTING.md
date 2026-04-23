# Contributing to web-acp

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to this project.

## Getting Started

### Prerequisites

- Node.js 22.x or later
- npm 10.x or later
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/web-acp.git
   cd web-acp
   ```
3. Install dependencies:
   ```bash
   npm ci
   ```
4. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Running Locally

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
```

### Code Quality

Before submitting a PR, ensure your code passes all quality checks:

```bash
npm run check        # Run lint + typecheck
npm run test         # Run unit tests
npm run test:e2e     # Run e2e tests (headed mode)
```

To auto-fix linting issues:

```bash
npm run lint:fix     # Fix ESLint + Prettier issues
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Check ESLint + Prettier (fails on issues) |
| `npm run lint:fix` | Auto-fix ESLint + Prettier issues |
| `npm run typecheck` | TypeScript type checking |
| `npm run check` | Run lint + typecheck |
| `npm run check:fix` | Run lint:fix + typecheck |
| `npm run test` | Run unit tests (once) |
| `npm run test:watch` | Run unit tests (watch mode) |
| `npm run test:coverage` | Run unit tests with coverage |
| `npm run test:e2e` | Run e2e tests (headed mode) |
| `npm run test:e2e:ui` | Run e2e tests (UI mode) |
| `npm run ci:test:e2e` | Run e2e tests (headless, for CI) |

## Commit Message Convention

We follow **Conventional Commits** to maintain a clean and semantic git history. This helps with:
- Automatic changelog generation
- Semantic versioning
- Better understanding of changes

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type

Must be one of the following:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that don't affect code meaning (formatting, whitespace)
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **perf**: Performance improvement
- **test**: Adding or updating tests
- **chore**: Changes to build process or auxiliary tools

### Scope (Optional)

The scope is the area of the codebase affected (e.g., `components`, `api`, `build`).

### Subject

- Use imperative, present tense: "add" not "added" nor "adds"
- Don't capitalize first letter
- No period at the end
- Keep it concise (50 characters or less)

### Body (Optional)

- Use imperative, present tense
- Explain what and why, not how
- Wrap at 72 characters

### Footer (Optional)

- Reference issues: `Fixes #123` or `Closes #456`
- Breaking changes: `BREAKING CHANGE: description`

### Examples

```bash
# Simple feature
feat: add dark mode toggle

# Bug fix with scope
fix(auth): handle expired tokens correctly

# Feature with body
feat: add user profile page

Add user profile page with avatar upload, bio editing, and
settings management. Includes form validation and error handling.

Fixes #42

# Breaking change
feat: migrate to React 19

BREAKING CHANGE: Requires Node.js 22+ and npm 10+. Update peer
dependencies and remove deprecated lifecycle methods.
```

### Enforcement

We **do not enforce** commit conventions via git hooks, but following them:
- Makes code review easier
- Helps maintain changelog
- Improves project history

## Pull Request Process

1. **Create a PR** using the PR template
2. **Fill out all sections** of the template
3. **Ensure CI passes** - all checks must be green
4. **Request review** from maintainers
5. **Address feedback** - make requested changes
6. **Squash commits** if needed for clean history

### PR Requirements

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No new warnings
- [ ] All CI checks pass

## Code Style

### TypeScript

- Use TypeScript strict mode
- Prefer explicit types over `any`
- Use interfaces for object types
- Document complex types

### React

- Use functional components with hooks
- Prefer named exports
- Keep components focused and small
- Use descriptive prop names

### Formatting

- 2 spaces for indentation
- Single quotes for strings
- Line width: 100 characters
- Trailing commas in ES5 syntax

ESLint and Prettier are configured to enforce these automatically.

## Testing

### Unit Tests (Vitest)

- Test file: `*.test.tsx` or `*.test.ts`
- Location: Next to the file being tested
- Run: `npm run test`

### E2E Tests (Playwright)

- Test file: `*.spec.ts`
- Location: `e2e/` directory
- Run: `npm run test:e2e` (headed) or `npm run ci:test:e2e` (headless)

### Test Guidelines

- Write tests for new features
- Update tests for bug fixes
- Aim for meaningful coverage
- Keep tests simple and focused

## Questions?

- Open a [Discussion](https://github.com/YOUR_ORG/web-acp/discussions)
- Review existing [Issues](https://github.com/YOUR_ORG/web-acp/issues)

Thank you for contributing! 🎉
