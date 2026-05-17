import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

// ── State machine ──────────────────────────────────────────────────────────────
// loading → ready → confirming → success | error | expired

export default function TransferConfirmPage() {
  const router = useRouter();
  const { token } = router.query;

  const [stage, setStage] = useState('loading');   // loading | ready | confirming | success | error | expired
  const [transfer, setTransfer] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);

  // ── Load transfer details on mount ────────────────────────────────────────

  useEffect(() => {
    if (!token) return;

    fetch(`/api/sms/transfer/verify?token=${token}`)
      .then(r => r.json())
      .then(data => {
        if (!data.valid) {
          setErrorMsg(data.error || 'Invalid or expired link');
          setStage(data.error?.toLowerCase().includes('expir') ? 'expired' : 'error');
          return;
        }
        setTransfer(data.transfer);
        setStage('ready');

        // Start countdown from expires_at
        const expiryMs = new Date(data.transfer.expires_at) - Date.now();
        setSecondsLeft(Math.max(0, Math.floor(expiryMs / 1000)));
      })
      .catch(() => {
        setErrorMsg('Failed to load transfer details. Please try again.');
        setStage('error');
      });
  }, [token]);

  // ── Expiry countdown ──────────────────────────────────────────────────────

  useEffect(() => {
    if (secondsLeft === null || secondsLeft <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          clearInterval(id);
          if (stage === 'ready') {
            setStage('expired');
            setErrorMsg('This link has expired. Please send a new transfer request via SMS.');
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft, stage]);

  // ── Confirm handler ───────────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    setStage('confirming');
    try {
      const res = await fetch('/api/sms/transfer/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!data.success) {
        setErrorMsg(data.error || 'Transfer failed. Please try again.');
        setStage('error');
        return;
      }
      setResult(data);
      setStage('success');
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.');
      setStage('error');
    }
  }, [token]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const formatCountdown = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // ── Render stages ─────────────────────────────────────────────────────────

  return (
    <>
      <Head>
        <title>Confirm Transfer — Vitta</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md">

          {/* Header */}
          <div className="text-center mb-6">
            <div className="text-2xl font-bold text-purple-700">Vitta</div>
            <div className="text-sm text-gray-500 mt-1">Secure Money Transfer</div>
          </div>

          {/* Loading */}
          {stage === 'loading' && (
            <Card>
              <div className="flex flex-col items-center py-8 gap-3">
                <Spinner />
                <p className="text-gray-500 text-sm">Loading transfer details…</p>
              </div>
            </Card>
          )}

          {/* Ready — show details and confirm button */}
          {stage === 'ready' && transfer && (
            <Card>
              <SectionLabel>Review Your Transfer</SectionLabel>
              <p className="text-xs text-gray-400 mt-0.5 mb-5">Initiated via SMS</p>

              {/* Amount */}
              <div className="text-center py-4 border-b border-gray-100 mb-4">
                <div className="text-4xl font-bold text-gray-900">
                  ${Number(transfer.source_amount).toFixed(2)}
                </div>
                <div className="text-sm text-gray-500 mt-1">{transfer.source_currency}</div>
              </div>

              {/* Details grid */}
              <div className="space-y-3 mb-6">
                <Row label="To" value={transfer.wise_recipient.account_holder_name} bold />
                <Row
                  label="Account"
                  value={
                    transfer.wise_recipient.upi_id
                      ? `UPI ****${transfer.wise_recipient.last4}`
                      : transfer.wise_recipient.last4
                        ? `****${transfer.wise_recipient.last4}`
                        : transfer.wise_recipient.type || '—'
                  }
                />
                <Row
                  label="Exchange Rate"
                  value={`1 ${transfer.source_currency} = ${Number(transfer.exchange_rate).toFixed(2)} ${transfer.target_currency}`}
                />
                <Row
                  label="Recipient Gets"
                  value={`${Number(transfer.target_amount).toFixed(2)} ${transfer.target_currency}`}
                />
                {transfer.fee_total !== null && (
                  <Row label="Transfer Fee" value={`$${Number(transfer.fee_total).toFixed(2)}`} />
                )}
                <div className="border-t border-gray-100 pt-3">
                  <Row
                    label="Total Cost"
                    value={`$${(Number(transfer.source_amount) + (transfer.fee_total || 0)).toFixed(2)} ${transfer.source_currency}`}
                    bold
                  />
                </div>
              </div>

              {/* Delivery note */}
              <p className="text-xs text-center text-gray-400 mb-6">⏱ Typically arrives within minutes</p>

              {/* Confirm button */}
              <button
                onClick={handleConfirm}
                className="w-full bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white font-semibold py-3 px-4 rounded-xl transition-colors"
              >
                Confirm Transfer
              </button>

              {/* Expiry countdown */}
              {secondsLeft !== null && (
                <p className="text-center text-xs text-gray-400 mt-4">
                  🔒 Secure · Link expires in{' '}
                  <span className={secondsLeft < 60 ? 'text-orange-500 font-medium' : ''}>
                    {formatCountdown(secondsLeft)}
                  </span>
                </p>
              )}
            </Card>
          )}

          {/* Confirming — spinner while WISE processes */}
          {stage === 'confirming' && (
            <Card>
              <div className="flex flex-col items-center py-8 gap-3">
                <Spinner />
                <p className="text-gray-700 font-medium">Processing transfer…</p>
                <p className="text-gray-400 text-xs">Please don&apos;t close this page</p>
              </div>
            </Card>
          )}

          {/* Success */}
          {stage === 'success' && result && (
            <Card>
              <div className="flex flex-col items-center py-6 gap-3">
                <div className="text-5xl">✅</div>
                <h2 className="text-xl font-bold text-gray-900">Transfer Complete!</h2>
                <p className="text-gray-500 text-sm text-center">
                  ${Number(transfer?.source_amount).toFixed(2)} sent to{' '}
                  {transfer?.wise_recipient?.account_holder_name}
                </p>
                {result.reference && (
                  <div className="bg-gray-50 rounded-lg px-4 py-2 mt-2 text-center">
                    <p className="text-xs text-gray-400">Reference</p>
                    <p className="text-sm font-mono font-medium text-gray-700">{result.reference}</p>
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-2">
                  You&apos;ll receive an SMS confirmation shortly.
                </p>
              </div>
            </Card>
          )}

          {/* Expired */}
          {stage === 'expired' && (
            <Card>
              <div className="flex flex-col items-center py-6 gap-3">
                <div className="text-4xl">⏰</div>
                <h2 className="text-xl font-bold text-gray-900">Link Expired</h2>
                <p className="text-gray-500 text-sm text-center">
                  This confirmation link has expired. Transfer links are valid for 15 minutes.
                </p>
                <p className="text-gray-400 text-xs text-center mt-2">
                  Send a new transfer request via SMS to get a fresh link.
                </p>
              </div>
            </Card>
          )}

          {/* Error */}
          {stage === 'error' && (
            <Card>
              <div className="flex flex-col items-center py-6 gap-3">
                <div className="text-4xl">❌</div>
                <h2 className="text-xl font-bold text-gray-900">Something went wrong</h2>
                <p className="text-gray-500 text-sm text-center">{errorMsg}</p>
                <button
                  onClick={() => router.reload()}
                  className="mt-2 text-purple-600 text-sm underline"
                >
                  Try again
                </button>
              </div>
            </Card>
          )}

          {/* Footer */}
          <p className="text-center text-xs text-gray-400 mt-6">
            🔒 Powered by Vitta · Secured by WISE
          </p>
        </div>
      </div>
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Card({ children }) {
  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return <h1 className="text-lg font-semibold text-gray-900">{children}</h1>;
}

function Row({ label, value, bold = false }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
        {value}
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-8 h-8 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
  );
}
