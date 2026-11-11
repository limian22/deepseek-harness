// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import type { ModelFavoritesState } from '../src/client/favorites.ts'
import type { ModelFavoritesFace } from '../src/client/slots.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Same lookup chain the real seat uses: package dictionary, then common, then key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? (commonZh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}
const renderSlot: ComponentProps<typeof ModelSelect>['renderSlot'] = (_name, _owner, options) => options?.fallback ?? null
const resolveText: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.en

function directory(): ModelDirectoryState {
  return {
    current: null,
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek Pro' },
      ],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
  }
}

function favoritesFace(initial: ModelFavoritesState): ModelFavoritesFace & { toggle: ReturnType<typeof vi.fn> } {
  const store = createSnapshotStore<ModelFavoritesState>(initial)
  const toggle = vi.fn(async (provider: string, model: string) => {
    store.update((draft) => {
      const key = `${provider}/${model}`
      const exists = draft.favorites.some(fav => `${fav.provider}/${fav.model}` === key)
      draft.favorites = exists
        ? draft.favorites.filter(fav => `${fav.provider}/${fav.model}` !== key)
        : [...draft.favorites, { provider, model }]
    })
    return true
  })
  return { store, toggle }
}

function mount(face: ModelFavoritesFace) {
  render(<ModelSelect locked={false} available directory={createSnapshotStore(directory())}
    load={vi.fn()} select={vi.fn()} favorites={face} resolveText={resolveText} t={t} renderSlot={renderSlot} />)
  fireEvent.click(screen.getByRole('button', { name: '请选择模型' }))
}

afterEach(cleanup)

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

describe('composer model favorites', () => {
  it('renders a star per model row and toggles the pair on click without selecting', () => {
    const face = favoritesFace({ status: 'ready', favorites: [] })
    mount(face)
    const flashStar = screen.getByRole('button', { name: '收藏 DeepSeek Flash' })
    expect(flashStar.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(flashStar)
    expect(face.toggle).toHaveBeenCalledWith('deepseek-official', 'deepseek-v4-flash')
  })

  it('pins favorited models into a leading 已收藏 group and marks the star pressed', () => {
    const face = favoritesFace({
      status: 'ready',
      favorites: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    })
    mount(face)
    // The pinned group heading and the provider heading both render.
    expect(screen.getByText('已收藏')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    const pinnedStar = screen.getByRole('button', { name: '取消收藏 DeepSeek Pro' })
    expect(pinnedStar.getAttribute('aria-pressed')).toBe('true')
    // Exclusive grouping: the pinned model appears exactly once.
    expect(screen.getAllByRole('menuitemradio', { name: 'DeepSeek Pro' })).toHaveLength(1)
  })

  it('hides the star affordance while the favorites namespace is unavailable', () => {
    const face = favoritesFace({ status: 'unavailable', favorites: [] })
    mount(face)
    expect(screen.queryByRole('button', { name: /收藏/ })).toBeNull()
    expect(screen.queryByText('已收藏')).toBeNull()
  })
})
