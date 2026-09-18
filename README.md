# Bases Structure

[![Available in Obsidian](https://img.shields.io/badge/Available%20in%20Obsidian-7C3AED?logo=obsidian&logoColor=white&style=flat-square)](https://obsidian.md/plugins?id=bases-structure)
[![Release](https://github.com/flowing-abyss/obsidian-bases-structure/actions/workflows/release.yml/badge.svg)](https://github.com/flowing-abyss/obsidian-bases-structure/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/flowing-abyss/obsidian-bases-structure/total?style=flat-square&label=downloads&color=blue)](https://github.com/flowing-abyss/obsidian-bases-structure/releases)

A Bases view that draws a note hierarchy starting from the note it is embedded in. You describe the types in the view itself, by tag, folder or property. A child points at its parent through a link property, or the parent links the child in its own text. Notes can be added, moved and retyped straight on the graph.

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
        Note: file.backlinks
    Note:
      tag: note
```

```
Home                ← area, embeds the base
├── Website          ← project: area: [[Home]]
│   ├── Design       ← task: project: [[Website]]
│   │   ├── Logo     ← task: parent: [[Design]], project inherited
│   │   └── Palette  ← note, because Design links [[Palette]] in its text
│   └── Launch
└── Garden
```
