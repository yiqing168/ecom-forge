export default function HealthPage() {
  return (
    <main>
      <h1>Web health</h1>
      <p>Next.js application is ready.</p>
      <span className="status" data-testid="web-health-status">
        ok
      </span>
    </main>
  );
}
