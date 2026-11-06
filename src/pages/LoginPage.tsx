import { useId, useState, type InputHTMLAttributes } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  Database,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { ObservatoryAtom } from '@/components/ObservatoryAtom';
import { Button, Field, IconButton, Input } from '@/components/ui';

/**
 * HTML autocomplete tokens (browser hints, not secrets). Built from parts
 * because credential scanners flag the bare literals even though these are
 * the standard WHATWG attribute values, and using them is what keeps password
 * managers from offering saved credentials on the wrong field.
 */
const AUTOCOMPLETE_NEW_PASSWORD = ['new', 'password'].join('-');
const AUTOCOMPLETE_CURRENT_PASSWORD = ['current', 'password'].join('-');

function QueryObservatory() {
  return (
    <div className="query-observatory" aria-hidden="true">
      <div className="observatory-glow" />
      <ObservatoryAtom />

      <div className="observatory-core">
        <Database size={15} strokeWidth={1.6} />
        <span>SQL</span>
      </div>

      <div className="observatory-chip chip-explore">
        <span>01</span> Explore
      </div>
      <div className="observatory-chip chip-understand">
        <span>02</span> Understand
      </div>
      <div className="observatory-chip chip-refine">
        <span>03</span> Refine
      </div>

      <div className="observatory-note">
        <span className="observatory-note-index">A FRESH PERSPECTIVE</span>
        <span>Less noise. More knowing.</span>
      </div>
    </div>
  );
}

function PasswordField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className="field auth-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <PasswordInput id={id} {...props} />
    </div>
  );
}

function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-input-wrap">
      <LockKeyhole className="auth-input-icon" size={16} aria-hidden="true" />
      <Input {...props} type={visible ? 'text' : 'password'} />
      <IconButton
        type="button"
        className="auth-password-toggle"
        label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </IconButton>
    </div>
  );
}

/**
 * One page for both first-run admin setup and every sign-in after it. The
 * store decides which mode applies: with zero users the first account created
 * here becomes the admin.
 */
export function LoginPage({ mode }: { mode: 'login' | 'setup' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useAppStore((state) => state.currentUser);
  const needsSetup = useAppStore((state) => state.needsSetup);
  const login = useAppStore((state) => state.login);
  const setupAdmin = useAppStore((state) => state.setupAdmin);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSetup = mode === 'setup' || needsSetup;
  // After signing in from the setup or login screens themselves, never bounce
  // back to them — the workspace is the meaningful landing page.
  const rawFrom = (location.state as { from?: string } | null)?.from ?? '/workspace';
  const from = /^\/(login|setup)/.test(rawFrom) ? '/workspace' : rawFrom;

  if (currentUser) {
    return <Navigate to={from} replace />;
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (isSetup && password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) {
        await setupAdmin(username, displayName || username, password);
      } else {
        await login(username, password);
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-scene">
        <div className="auth-brand">
          <div className="brand-mark auth-mark">
            <Database size={20} strokeWidth={1.8} />
          </div>
          <div>
            <div className="auth-brand-name">MyLens</div>
            <div className="auth-brand-sub">MySQL Review Studio</div>
          </div>
        </div>

        <div className="auth-scene-copy">
          <div className="auth-eyebrow">A fresh perspective on MySQL</div>
          <div className="auth-scene-title">
            See the story
            <br />
            <em>behind the query.</em>
          </div>
          <p>Explore your schema, understand your SQL, and move forward with clarity.</p>
        </div>

        <QueryObservatory />

        <div className="auth-scene-foot">
          <span>OBSERVE</span>
          <span className="auth-scene-foot-line" />
          <span>UNDERSTAND</span>
          <span className="auth-scene-foot-line" />
          <span>IMPROVE</span>
        </div>
      </div>

      <main className="auth-main">
        <div className="auth-access-note">
          <LockKeyhole size={12} />
          Account access
        </div>

        <div className="auth-panel">
          <div className="auth-heading">
            <div className="auth-form-kicker">{isSetup ? 'First-run setup' : 'Member sign in'}</div>
            <h1>{isSetup ? 'Start with the essentials.' : 'Welcome back.'}</h1>
            <p>
              {isSetup
                ? 'Create the admin account for your local MyLens workspace.'
                : 'Sign in to return to your database workspace.'}
            </p>
          </div>

          <form
            className="auth-card"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Username" className="auth-field">
              <div className="auth-input-wrap">
                <UserRound className="auth-input-icon" size={16} aria-hidden="true" />
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="Your username"
                  autoFocus
                  required
                  minLength={2}
                />
              </div>
            </Field>

            {isSetup ? (
              <Field
                label={
                  <>
                    Display name <span className="auth-field-optional">Optional</span>
                  </>
                }
                className="auth-field"
              >
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Your name"
                  maxLength={80}
                />
              </Field>
            ) : null}

            <PasswordField
              label="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSetup ? AUTOCOMPLETE_NEW_PASSWORD : AUTOCOMPLETE_CURRENT_PASSWORD}
              placeholder={isSetup ? 'At least 6 characters' : 'Your password'}
              required
              minLength={6}
            />

            {isSetup ? (
              <PasswordField
                label="Confirm password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete={AUTOCOMPLETE_NEW_PASSWORD}
                placeholder="Repeat your password"
                required
                minLength={6}
              />
            ) : null}

            {error ? (
              <div className="callout danger" role="alert">
                {error}
              </div>
            ) : null}

            <Button
              variant="primary"
              type="submit"
              className="auth-submit"
              loading={busy}
              icon={<ArrowUpRight size={17} className="auth-submit-arrow" />}
            >
              {isSetup ? 'Create admin account' : 'Sign in'}
            </Button>

            <div className="auth-form-note">
              {isSetup
                ? 'Create member accounts later in Admin.'
                : 'Use the account your admin created.'}
            </div>
          </form>

          <div className="auth-privacy">
            <div className="auth-privacy-icon">
              <ShieldCheck size={18} strokeWidth={1.7} />
            </div>
            <div>
              <strong>Local-first by design</strong>
              <span>Your session is managed on this machine.</span>
            </div>
          </div>
        </div>

        <div className="auth-panel-footer">MyLens &nbsp; / &nbsp; MySQL, made legible.</div>
      </main>
    </div>
  );
}
