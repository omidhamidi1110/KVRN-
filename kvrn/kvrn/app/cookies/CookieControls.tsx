'use client'

export function CookieControls() {
  const handleAccept = () => {
    localStorage.setItem('kvrn_cookie_consent', JSON.stringify({ state: 'granted', ts: Date.now() }))
    window.location.reload()
  }

  const handleDecline = () => {
    localStorage.setItem('kvrn_cookie_consent', JSON.stringify({ state: 'denied', ts: Date.now() }))
    window.location.reload()
  }

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-kvrn-muted leading-relaxed">
        You can change your analytics cookie preference at any time.
        Declining removes analytics cookies and prevents new ones being set.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleAccept}
          className="text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 h-9 hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
        >
          Accept analytics
        </button>
        <button
          onClick={handleDecline}
          className="text-[11px] font-light tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
        >
          Decline analytics
        </button>
      </div>
      <p className="text-[13px] text-kvrn-muted leading-relaxed">
        You can also control cookies through your browser settings. Disabling essential cookies
        will affect site functionality (shopping bag will not persist).
      </p>
    </div>
  )
}
