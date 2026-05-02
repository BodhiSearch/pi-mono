# 05. Multi-volume mounts

The agent runs against a virtual filesystem (ZenFS). Each mount
appears at `/mnt/<name>` to the bash tool and to the vault command
loader.

## Default mount: `/mnt/cwd`

Booting `cli-acp-client --cwd <path>` auto-mounts `<path>` at
`/mnt/cwd` via `PassthroughFS` — nothing more, nothing less. There
is no implicit mount of `/`, no implicit `~`.

## `/volume` command

```
> /volume add /Users/alice/notes notes
Mounted /Users/alice/notes at /mnt/notes.

> /volume list
Volumes (2):
  /mnt/cwd      Current working directory: /tmp/proj
  /mnt/notes    Mounted directory: /Users/alice/notes

> /volume remove notes
Unmounted /mnt/notes.
```

Mount entries persist in sqlite (`KV_VOLUMES`); the next launch
re-mounts every entry that still resolves on disk. If a path is
deleted out of band, the boot mount is silently skipped (no crash).

## Why multiple mounts matter

Two reasons:

1. **Bash sandbox scope** — the agent can only read/write inside
   mounted volumes. Adding `/Users/alice/notes` lets it edit that
   directory without granting it the entire filesystem.
2. **Vault command discovery** — the agent scans every mounted
   volume's `.commands/` directory at session start. A command
   defined at `/Users/alice/notes/.commands/greet.md` is invokable
   as `/notes:greet` once the volume is mounted.

## Naming rules

`mountName` is sanitised: lowercase a–z, 0–9, `-`, `_`. Whitespace
and special characters become a single `-`. If you don't pass a
name, the directory's `basename` (sanitised) is used. Mount names
must be unique within a process; pick a different one if you hit
`Mount '<name>' is already in use`.

## Removing the default mount

You can't — the cwd mount is added at boot every time. If you need
to swap it, restart with `--cwd <new path>`.
