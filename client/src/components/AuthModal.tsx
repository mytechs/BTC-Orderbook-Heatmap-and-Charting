import React, { useEffect, useState } from 'react';
import type { AuthUserInfo, UserWorkspaceState } from '../../../shared/types.ts';

interface AuthModalProps {
  initialMode?: 'login' | 'register';
  getCurrentWorkspaceState: () => UserWorkspaceState;
  onClose: () => void;
  onAuthenticated: (user: AuthUserInfo, state: UserWorkspaceState, isNewAccount: boolean) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  initialMode = 'login',
  getCurrentWorkspaceState,
  onClose,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = username.trim();
    if (trimmed.length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload =
        mode === 'register'
          ? { username: trimmed, password, initialState: getCurrentWorkspaceState() }
          : { username: trimmed, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        authenticated?: boolean;
        user?: AuthUserInfo;
        state?: UserWorkspaceState;
        error?: string;
      };
      if (!res.ok || !data.authenticated || !data.user) {
        setError(data.error || 'Authentication failed.');
        return;
      }
      onAuthenticated(data.user, data.state || {}, mode === 'register');
      onClose();
    } catch {
      setError('Could not reach server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-modal-backdrop" onClick={onClose}>
      <div
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="auth-modal-header">
          <strong>Workspace Account</strong>
          <button type="button" className="auth-close-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <p className="auth-subtitle">
          Save your active page, exchange, timeframe, indicators, heatmap settings, and all chart
          drawings on the server so every restart opens exactly as you left it.
        </p>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login');
              setError(null);
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'active' : ''}
            onClick={() => {
              setMode('register');
              setError(null);
            }}
          >
            Create Account
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Username</span>
            <input
              type="text"
              autoFocus
              autoComplete="username"
              placeholder="e.g. trader1"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </label>

          {mode === 'register' && (
            <label className="auth-field">
              <span>Confirm Password</span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit-btn" disabled={submitting}>
            {submitting
              ? mode === 'register'
                ? 'Creating Account…'
                : 'Signing In…'
              : mode === 'register'
                ? 'Create Account & Save Settings'
                : 'Sign In & Restore Workspace'}
          </button>
        </form>
      </div>
    </div>
  );
};
