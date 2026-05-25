export const dynamic = 'force-dynamic';

// Discover (PROFILE_SYSTEM_PLAN U5). v1 placeholder — search/explore lands here.
// Kept as a real route so the bottom-nav Discover tab never dead-ends.

export default function DiscoverPage() {
  return (
    <main className="oak-profile">
      <h1 className="oak-profile-name">Discover</h1>
      <p className="oak-empty">Search and creator discovery are coming soon. For now, browse the feed.</p>
      <div style={{ textAlign: 'center' }}>
        <a className="oak-btn-primary" href="/">
          Go to feed
        </a>
      </div>
    </main>
  );
}
