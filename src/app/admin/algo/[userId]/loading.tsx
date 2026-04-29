export default function Loading() {
  return (
    <main>
      <a href="/admin/algo" style={{ fontSize: 13, opacity: 0.7 }}>← Algo</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 24 }}>Loading…</h1>
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ height: 80, background: '#111', borderRadius: 6 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ height: 200, background: '#111', borderRadius: 6 }} />
          <div style={{ height: 200, background: '#111', borderRadius: 6 }} />
        </div>
        <div style={{ height: 60, background: '#111', borderRadius: 6 }} />
        <div style={{ height: 120, background: '#111', borderRadius: 6 }} />
        <div style={{ height: 300, background: '#111', borderRadius: 6 }} />
      </div>
    </main>
  );
}
