# Bases Structure

[![Release](https://github.com/flowing-abyss/obsidian-bases-structure/actions/workflows/release.yml/badge.svg)](https://github.com/flowing-abyss/obsidian-bases-structure/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/flowing-abyss/obsidian-bases-structure/total?style=flat-square&label=downloads&color=blue)](https://github.com/flowing-abyss/obsidian-bases-structure/releases)

A Bases view that draws a note hierarchy from the note it's embedded in. Types are defined right in the view — by tag, folder, or property — and each child points to its parent with a link property. Add, move, and retype notes right on the graph.

```yaml
- type: structure
  name: Structure
  inherit:
    - project
  types:
    Area:
      tag: area
      children:
        Project: area
    Project:
      tag: project
      children:
        Task: project
    Task:
      tag: task
      children:
        Task: parent
```

```
Home               ← area, embeds the base
├── Website        ← project: area: [[Home]]
│   ├── Design     ← task: project: [[Website]]
│   │   └── Logo   ← task: parent: [[Design]], project inherited
│   └── Launch
└── Garden
```
