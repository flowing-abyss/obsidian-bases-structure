import type { App } from 'obsidian';
import { App as AppMock } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  applySuperchargedLinkAttributes,
  hookSuperchargedLinks,
  type SuperchargedWatch,
  unhookSuperchargedLinks,
} from './supercharged-links.js';

describe('applySuperchargedLinkAttributes', () => {
  it('copies scalar frontmatter values as data-link-* attributes and CSS variables, skipping position and non-scalars', () => {
    const app = AppMock.createConfigured__();
    app.metadataCache.setCache__('note.md', {
      frontmatter: {
        type: 'book',
        rating: 5,
        archived: false,
        tags: ['skip'],
        position: 'skip',
      },
    });
    const link = createDiv();

    applySuperchargedLinkAttributes(app.asOriginalType__(), link, 'note.md');

    expect(link.getAttribute('data-link-type')).toBe('book');
    expect(link.style.getPropertyValue('--data-link-type')).toBe('book');
    expect(link.getAttribute('data-link-rating')).toBe('5');
    expect(link.getAttribute('data-link-archived')).toBe('false');
    expect(link.hasAttribute('data-link-tags')).toBe(false);
    expect(link.hasAttribute('data-link-position')).toBe(false);
  });

  it('does nothing when the note has no frontmatter', () => {
    const app = AppMock.createConfigured__();
    const link = createDiv();

    expect(() => {
      applySuperchargedLinkAttributes(app.asOriginalType__(), link, 'note.md');
    }).not.toThrow();
    expect(link.attributes).toHaveLength(0);
  });
});

describe('supercharged-links watch scoping', () => {
  function appWithSl() {
    const observers: Array<[{ disconnect: () => void }, string]> = [];
    const app = {
      plugins: {
        plugins: {
          'supercharged-links-obsidian': {
            observers,
            _watchContainerDynamic: (watchKey: string) => {
              observers.push([{ disconnect: vi.fn() }, watchKey]);
            },
          },
        },
      },
    } as unknown as App;
    return { app, observers };
  }

  const container = () => createDiv();

  it('namespaces the watch key with the owner id', () => {
    const { app, observers } = appWithSl();

    hookSuperchargedLinks(
      app,
      { ownerId: 'bases-structure', id: 'graph-1' },
      container(),
      'a',
      'row',
    );

    expect(observers.map(([, key]) => key)).toEqual(['bases-structure:graph-1']);
  });

  it('falls back to the bare id when no owner is known', () => {
    const { app, observers } = appWithSl();

    hookSuperchargedLinks(app, { ownerId: undefined, id: 'graph-1' }, container(), 'a', 'row');

    expect(observers.map(([, key]) => key)).toEqual(['graph-1']);
  });

  it('falls back to the bare id when the owner id is an empty string', () => {
    const { app, observers } = appWithSl();

    hookSuperchargedLinks(app, { ownerId: '', id: 'graph-1' }, container(), 'a', 'row');

    expect(observers.map(([, key]) => key)).toEqual(['graph-1']);
  });

  it('unhooking one copy leaves another copy of the same container watching', () => {
    const { app, observers } = appWithSl();
    hookSuperchargedLinks(
      app,
      { ownerId: 'bases-structure', id: 'graph-1' },
      container(),
      'a',
      'row',
    );
    hookSuperchargedLinks(
      app,
      { ownerId: 'bases-structure-beta', id: 'graph-1' },
      container(),
      'a',
      'row',
    );

    unhookSuperchargedLinks(app, { ownerId: 'bases-structure', id: 'graph-1' });

    expect(observers.map(([, key]) => key)).toEqual(['bases-structure-beta:graph-1']);
  });

  it('unhooks several watches in one call', () => {
    const { app, observers } = appWithSl();
    const own: SuperchargedWatch = { ownerId: 'bases-structure', id: 'graph-1' };
    const other: SuperchargedWatch = { ownerId: 'bases-structure', id: 'outline-1' };
    hookSuperchargedLinks(app, own, container(), 'a', 'row');
    hookSuperchargedLinks(app, other, container(), 'a', 'row');

    unhookSuperchargedLinks(app, own, other);

    expect(observers).toEqual([]);
  });

  it('disconnects the observer it removes', () => {
    const { app, observers } = appWithSl();
    const watch: SuperchargedWatch = { ownerId: 'bases-structure', id: 'graph-1' };
    hookSuperchargedLinks(app, watch, container(), 'a', 'row');
    const disconnect = observers[0]?.[0].disconnect;

    unhookSuperchargedLinks(app, watch);

    expect(disconnect).toHaveBeenCalled();
  });

  it('continues removing owned observers when one disconnect throws, then re-throws it', () => {
    const { app, observers } = appWithSl();
    const own: SuperchargedWatch = { ownerId: 'bases-structure', id: 'graph-1' };
    const foreign: SuperchargedWatch = { ownerId: 'bases-structure-beta', id: 'graph-1' };
    hookSuperchargedLinks(app, own, container(), 'a', 'row');
    const failure = new Error('disconnect failed');
    observers.push([
      {
        disconnect: vi.fn(() => {
          throw failure;
        }),
      },
      'bases-structure:graph-1',
    ]);
    hookSuperchargedLinks(app, foreign, container(), 'a', 'row');
    const firstOwnDisconnect = observers[0]?.[0].disconnect;

    expect(() => {
      unhookSuperchargedLinks(app, own);
    }).toThrow(failure);

    expect(firstOwnDisconnect).toHaveBeenCalledOnce();
    expect(observers.map(([, key]) => key)).toEqual(['bases-structure-beta:graph-1']);
  });

  it('hookSuperchargedLinks is a no-op when the plugin is absent', () => {
    const app = { plugins: { plugins: {} } } as unknown as App;

    expect(() => {
      hookSuperchargedLinks(app, { ownerId: 'x', id: 'graph-1' }, container(), 'a', 'row');
    }).not.toThrow();
  });

  it('hookSuperchargedLinks is a no-op when _watchContainerDynamic is not a function', () => {
    const app = {
      plugins: { plugins: { 'supercharged-links-obsidian': { observers: [] } } },
    } as unknown as App;

    expect(() => {
      hookSuperchargedLinks(app, { ownerId: 'x', id: 'graph-1' }, container(), 'a', 'row');
    }).not.toThrow();
  });

  it('unhookSuperchargedLinks is a no-op when the plugin is absent', () => {
    const app = {} as unknown as App;

    expect(() => {
      unhookSuperchargedLinks(app, { ownerId: 'x', id: 'graph-1' });
    }).not.toThrow();
  });

  it('unhookSuperchargedLinks is a no-op when observers is not an array', () => {
    const app = {
      plugins: { plugins: { 'supercharged-links-obsidian': {} } },
    } as unknown as App;

    expect(() => {
      unhookSuperchargedLinks(app, { ownerId: 'x', id: 'graph-1' });
    }).not.toThrow();
  });
});
