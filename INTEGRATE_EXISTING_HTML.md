# Wiring your existing dashboard HTML to the proxy

You already have `05_Client_Dashboard_Briana.html` from the implementation
guide. To use it instead of the minimal starter page:

1. Rename it (or copy it) to `public/clients/briana/index.html`,
   replacing the placeholder this repo ships with.

2. In the `<script type="text/babel">` block at the bottom of that file,
   find the static `DATA` constant near the top and replace the `App`
   component shell with one that fetches from the proxy.

Find this (roughly):

```js
const DATA = {
  client: { /* ... lots of static April data ... */ },
  // ...
};

function App() {
  return (
    <div className="max-w-5xl mx-auto px-6 md:px-10">
      <Header client={DATA.client} />
      {/* ... */}
    </div>
  );
}
```

Replace with:

```js
const { useState, useEffect } = React;

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/client-dashboard/briana')
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(setData)
      .catch(() => setError('Could not load dashboard data. Refresh in a moment.'));
  }, []);

  if (error) return <div className="max-w-5xl mx-auto p-10 text-center">{error}</div>;
  if (!data)  return <div className="max-w-5xl mx-auto p-10 text-center ink-muted italic">Loading…</div>;

  const r = data.currentReport;
  return (
    <div className="max-w-5xl mx-auto px-6 md:px-10">
      <Header           client={data.client} />
      <Strategy         strategy={data.strategy} />
      <WeeklyRhythm     rhythm={data.weeklyRhythm} />
      <CampaignProgress campaigns={data.campaignProgress} />
      <UpcomingShoots   shoots={data.shoots} />
      <InFlight         items={data.inFlight} />
      <RecentContent    posts={data.recentContent} />
      <Performance      current={r} previous={data.previousReport} />
      <TopPosts         posts={r?.topPosts || []} />
      <Audience         audience={r?.audience} />
      <Ads              ads={r?.ads || []} note={r?.adsNote} />
      <Insights         learned={r?.learned} testingNext={r?.testingNext} dataNotes={r?.dataNotes} />
      <WaitingOnYou     approvals={data.approvals} />
      <Footer           client={data.client} />
    </div>
  );
}
```

That's the only change. Every other React component in the file stays
exactly the same; they keep receiving the same prop shapes (see the
data contract in `CLIENT_DASHBOARD_IMPLEMENTATION_GUIDE.md`, Appendix C).

The starter `index.html` that ships in this repo can be deleted once
you've dropped in your real dashboard.
