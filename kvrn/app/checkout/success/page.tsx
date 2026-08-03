// NOTE: Payment is NOT confirmed here. Stripe webhook verification is the next phase.
export default function CheckoutSuccessPage() {
  return (
    <div
      data-nav-theme="light"
      style={{
        minHeight: '100vh',
        background: '#F9F8F6',
        paddingTop: 'calc(36px + 56px + 48px)',  // announcement bar + nav + gap
      }}
    >
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 24px', textAlign: 'center', fontFamily: 'system-ui,sans-serif' }}>
        <h1 style={{ fontSize: 26, marginBottom: 16, fontWeight: 400, color: '#1A1A1A' }}>Thank you.</h1>
        <p style={{ color: '#6b7280', lineHeight: 1.7, fontSize: 15 }}>
          Your order has been submitted. You'll receive a confirmation email once payment is verified.
        </p>
      </div>
    </div>
  )
}
