import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ForgotPasswordPage from './ForgotPasswordPage'
import ResetPasswordPage from './ResetPasswordPage'

const authRecoveryPostMock = vi.fn()
const authResetPostMock = vi.fn()

vi.mock('@/api/client', () => ({
  authApi: {
    authRecoveryPost: (...args: unknown[]) => authRecoveryPostMock(...args),
    authResetPost: (...args: unknown[]) => authResetPostMock(...args),
  },
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  }
})

describe('password recovery flow', () => {
  it('sends the recovery email request with a trimmed email address', async () => {
    authRecoveryPostMock.mockReset()
    authRecoveryPostMock.mockResolvedValue({ data: 'ok' })

    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    )

    await user.type(screen.getByLabelText('auth.email'), '  user@example.com  ')
    await user.click(screen.getByRole('button', { name: 'auth.sendResetLink' }))

    await waitFor(() => {
      expect(authRecoveryPostMock).toHaveBeenCalledWith({
        request: {
          email: 'user@example.com',
        },
      })
    })
  })

  it('sends the reset request with the route user id preserved as a string', async () => {
    authResetPostMock.mockReset()
    authResetPostMock.mockResolvedValue({ data: 'ok' })

    const user = userEvent.setup()
    const resetToken = '1234567890123456789012345678901234567890'

    render(
      <MemoryRouter initialEntries={[`/reset/2230469276416868352/${resetToken}`]}>
        <Routes>
          <Route path="/reset/:userId/:token" element={<ResetPasswordPage />} />
          <Route path="/" element={<div>signed in</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await user.type(screen.getByLabelText('auth.newPassword'), 'N3wVerYstR0NgP@66WoR6')
    await user.type(screen.getByLabelText('auth.confirmPassword'), 'N3wVerYstR0NgP@66WoR6')
    await user.click(screen.getByRole('button', { name: 'auth.resetPassword' }))

    await waitFor(() => {
      expect(authResetPostMock).toHaveBeenCalledWith({
        request: {
          id: '2230469276416868352',
          password: 'N3wVerYstR0NgP@66WoR6',
          token: resetToken,
        },
      })
    })
  })
})
