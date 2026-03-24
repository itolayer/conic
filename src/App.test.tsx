// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import App from './App'
import { resetConicUiStore, useConicStore } from './lib/ui/store'

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    resetConicUiStore()
  })

  it('renders the demo-focused UI shell', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: /^CONIC$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Privacy Agent/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Recent Intents/i })).toBeInTheDocument()
    expect(screen.getByText(/Describe Privacy Goal/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Round Monitor/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Connect Session/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Autopilot idle/i)).toBeInTheDocument()
  })

  it('updates the network-specific endpoints when switching to testnet', () => {
    render(<App />)

    fireEvent.click(screen.getAllByRole('button', { name: /connect/i })[0]!)

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'testnet' },
    })

    expect(useConicStore.getState().network).toBe('testnet')
  })
})
