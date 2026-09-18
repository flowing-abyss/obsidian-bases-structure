import type { PluginManifest } from 'obsidian';
import { App, BasesViewConfig, Plugin, QueryController } from 'obsidian-test-mocks/obsidian';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StructureViewPlugin, { STRUCTURE_VIEW_ID } from './main.js';
import { StructureView } from './view/structure-view.js';

interface PluginWithNotify {
  notify(message: string): void;
}

function spyOnNotify(plugin: StructureViewPlugin): Mock<(message: string) => void> {
  return vi
    .spyOn(plugin as unknown as PluginWithNotify, 'notify')
    .mockImplementation(() => undefined);
}

/** Exposes the mock's test-only tracking fields (`basesViewRegistrations__`, `commands__`, ...)
 * for a plugin instance typed through the real `obsidian` `Plugin` in production code. */
function mocked(plugin: StructureViewPlugin): Plugin {
  return Plugin.fromOriginalType2__(plugin);
}

const manifest: PluginManifest = {
  id: 'bases-structure',
  name: 'Bases Structure',
  author: 'test',
  version: '0.0.0-test',
  minAppVersion: '1.10.3',
  description: 'Test manifest',
};

function createPlugin(): StructureViewPlugin {
  const app = App.createConfigured__();
  return new StructureViewPlugin(app.asOriginalType__(), manifest);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StructureViewPlugin.onload', () => {
  it('registers the structure bases view with a name, icon and factory', () => {
    const plugin = createPlugin();

    plugin.onload();

    const registration = mocked(plugin).basesViewRegistrations__.get(STRUCTURE_VIEW_ID);
    expect(registration?.name).toBe('Structure');
    expect(registration?.icon).toBe('git-fork');
    expect(typeof registration?.factory).toBe('function');
  });

  it('the registered factory builds a StructureView bound to this plugin', () => {
    const app = App.createConfigured__();
    const plugin = createPlugin();
    plugin.onload();
    const registration = mocked(plugin).basesViewRegistrations__.get(STRUCTURE_VIEW_ID);
    const controller = QueryController.create2__(app, plugin, createDiv());
    const containerEl = createDiv();

    const view = registration?.factory(controller.asOriginalType2__(), containerEl);

    expect(view).toBeInstanceOf(StructureView);
  });

  it('exposes the layout, direction and edge-labels options', () => {
    const plugin = createPlugin();
    plugin.onload();
    const registration = mocked(plugin).basesViewRegistrations__.get(STRUCTURE_VIEW_ID);
    const config = BasesViewConfig.create__('', STRUCTURE_VIEW_ID, 'Structure');

    const options = registration?.options?.(config.asOriginalType__()) ?? [];

    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({
      type: 'dropdown',
      key: 'layout',
      displayName: 'Layout',
      options: { graph: 'Graph', outline: 'Outline' },
      default: 'graph',
    });
    expect(options[1]).toMatchObject({
      type: 'dropdown',
      key: 'direction',
      displayName: 'Direction',
      options: { right: 'Left to right', down: 'Top to bottom' },
      default: 'right',
    });
    expect(options[2]).toMatchObject({
      type: 'toggle',
      key: 'edgeLabels',
      displayName: 'Show link types',
      default: false,
    });
  });

  it('hides the direction option for the outline layout and shows it for the graph (U3)', () => {
    const plugin = createPlugin();
    plugin.onload();
    const registration = mocked(plugin).basesViewRegistrations__.get(STRUCTURE_VIEW_ID);
    const config = BasesViewConfig.create__('', STRUCTURE_VIEW_ID, 'Structure');

    const options = registration?.options?.(config.asOriginalType__()) ?? [];
    const directionOption = options[1];
    if (directionOption?.type !== 'dropdown') {
      throw new Error('expected the direction dropdown option to exist');
    }

    // Config default (nothing set yet) behaves like the graph layout: direction stays visible.
    expect(directionOption.shouldHide?.()).toBe(false);

    config.set('layout', 'outline');
    expect(directionOption.shouldHide?.()).toBe(true);

    config.set('layout', 'graph');
    expect(directionOption.shouldHide?.()).toBe(false);
  });

  it('hides the edge-labels option for the outline layout and shows it for the graph (D2)', () => {
    const plugin = createPlugin();
    plugin.onload();
    const registration = mocked(plugin).basesViewRegistrations__.get(STRUCTURE_VIEW_ID);
    const config = BasesViewConfig.create__('', STRUCTURE_VIEW_ID, 'Structure');

    const options = registration?.options?.(config.asOriginalType__()) ?? [];
    const edgeLabelsOption = options[2];
    if (edgeLabelsOption?.type !== 'toggle') {
      throw new Error('expected the edgeLabels toggle option to exist');
    }

    // Config default (nothing set yet) behaves like the graph layout: it stays visible.
    expect(edgeLabelsOption.shouldHide?.()).toBe(false);

    config.set('layout', 'outline');
    expect(edgeLabelsOption.shouldHide?.()).toBe(true);

    config.set('layout', 'graph');
    expect(edgeLabelsOption.shouldHide?.()).toBe(false);
  });

  it('registers a hover-link-preview source matching the event attachNodeInteractions fires (M4)', () => {
    const plugin = createPlugin();

    plugin.onload();

    const source = mocked(plugin).hoverLinkSources__.get('bases-structure');
    expect(source).toStrictEqual({ display: 'Bases Structure', defaultMod: true });
  });

  it('registers the undo command with a check callback reflecting undo.canUndo', () => {
    const plugin = createPlugin();

    plugin.onload();

    const command = mocked(plugin).commands__.get('undo-last-change');
    expect(command?.name).toBe('Undo last structure change');
    expect(command?.checkCallback?.(true)).toBe(false);

    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    expect(command?.checkCallback?.(true)).toBe(true);
  });
});

describe('StructureViewPlugin — undo command invocation', () => {
  it('shows a "nothing to undo" notice when the stack reports no label', async () => {
    const plugin = createPlugin();
    plugin.onload();
    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    vi.spyOn(plugin.undo, 'undo').mockResolvedValue({ label: null, skipped: [] });
    const notifySpy = spyOnNotify(plugin);
    const command = mocked(plugin).commands__.get('undo-last-change');

    command?.checkCallback?.(false);
    await vi.waitFor(() => {
      expect(notifySpy).toHaveBeenCalled();
    });

    expect(notifySpy).toHaveBeenCalledWith('Structure: nothing to undo');
  });

  it('shows an "undone" notice with skipped display names appended (I1) — falls back to the path basename with no snapshot to resolve against', async () => {
    const plugin = createPlugin();
    plugin.onload();
    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    vi.spyOn(plugin.undo, 'undo').mockResolvedValue({
      label: 'Move note',
      skipped: ['a.md', 'b.md'],
    });
    const notifySpy = spyOnNotify(plugin);
    const command = mocked(plugin).commands__.get('undo-last-change');

    command?.checkCallback?.(false);
    await vi.waitFor(() => {
      expect(notifySpy).toHaveBeenCalled();
    });

    expect(notifySpy).toHaveBeenCalledWith('Structure: undone "Move note" (skipped a, b)');
  });

  it('lists up to 3 skipped names, then a "+N more" tail', async () => {
    const plugin = createPlugin();
    plugin.onload();
    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    vi.spyOn(plugin.undo, 'undo').mockResolvedValue({
      label: 'Move note',
      skipped: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
    });
    const notifySpy = spyOnNotify(plugin);
    const command = mocked(plugin).commands__.get('undo-last-change');

    command?.checkCallback?.(false);
    await vi.waitFor(() => {
      expect(notifySpy).toHaveBeenCalled();
    });

    expect(notifySpy).toHaveBeenCalledWith(
      'Structure: undone "Move note" (skipped a, b, c, +2 more)',
    );
  });

  it('shows an "undone" notice with no suffix when nothing was skipped', async () => {
    const plugin = createPlugin();
    plugin.onload();
    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    vi.spyOn(plugin.undo, 'undo').mockResolvedValue({ label: 'Move note', skipped: [] });
    const notifySpy = spyOnNotify(plugin);
    const command = mocked(plugin).commands__.get('undo-last-change');

    command?.checkCallback?.(false);
    await vi.waitFor(() => {
      expect(notifySpy).toHaveBeenCalled();
    });

    expect(notifySpy).toHaveBeenCalledWith('Structure: undone "Move note"');
  });

  it('logs and shows a failure notice when undo.undo rejects', async () => {
    const plugin = createPlugin();
    plugin.onload();
    vi.spyOn(plugin.undo, 'canUndo', 'get').mockReturnValue(true);
    vi.spyOn(plugin.undo, 'undo').mockRejectedValue(new Error('disk error'));
    const notifySpy = spyOnNotify(plugin);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const command = mocked(plugin).commands__.get('undo-last-change');

    command?.checkCallback?.(false);
    await vi.waitFor(() => {
      expect(notifySpy).toHaveBeenCalled();
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    expect(notifySpy).toHaveBeenCalledWith('Structure: undo failed');
  });

  it('notify shows a real Notice without throwing', () => {
    const plugin = createPlugin();
    const notify = (plugin as unknown as PluginWithNotify).notify.bind(plugin);

    expect(() => {
      notify('Structure: test message');
    }).not.toThrow();
  });
});

describe('StructureViewPlugin.onunload', () => {
  it('does not throw', () => {
    const plugin = createPlugin();
    plugin.onload();

    expect(() => {
      plugin.onunload();
    }).not.toThrow();
  });
});
