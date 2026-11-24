# Resource packages

A resource package distributes skills, prompt templates and themes. Install a Git repository or an existing directory from the CLI:

```sh
wasmedge-agent package install git:github.com/OWNER/REPO@TAG
wasmedge-agent package install ./my-resources
wasmedge-agent package list
wasmedge-agent package update git:github.com/OWNER/REPO
wasmedge-agent package remove ./my-resources
```

Git URLs can use HTTPS or SSH. An unpinned checkout follows its upstream branch. A tag or commit pins the checkout. Local packages are used in place. Installs persist in user settings; repository settings cannot activate packages.

## Package structure

With no resource manifest, discovery uses `skills/` for skill folders with a `SKILL.md`, `prompts/` for Markdown templates and `themes/` for JSON themes. To select files explicitly, add `wasmedge-agent.json` at the package root:

```json
{
  "skills": ["my-skills/*"],
  "prompts": ["prompts", "!**/draft.md"],
  "themes": ["themes/dark.json"]
}
```

The manifest lists the resource types and paths the publisher wants to expose. The object form in user settings can narrow them further. A `!` pattern excludes matches; `+` and `-` target exact paths relative to the package root. An empty array disables that resource type.

```json
{
  "packages": [
    {
      "source": "git:github.com/OWNER/REPO@TAG",
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

## Migrating existing packages

Replace each `npm:` entry with the resource package's Git URL or its local source directory. Run `wasmedge-agent package remove 'npm:@scope/name@version'` with the source as listed to clear an old entry. Startup skips those entries, and removal only updates the agent settings.

For an existing Git or local package, copy the `skills`, `prompts` and `themes` arrays from the old `package.json` object's `pi` field to the top level of `wasmedge-agent.json`. The native manifest takes precedence. Until a package is migrated, the reader honors its old resource filters as JSON data. Git install and update only check out files.

Use the [Rust SDK](sdk.md) to register executable tools in an embedded session.
