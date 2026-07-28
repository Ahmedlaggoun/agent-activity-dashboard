const metrics = [
  {
    tone: 'time',
    symbol: '⏱',
    label: 'Active turn',
    description: 'Time since the current prompt started',
  },
  {
    tone: 'tokens',
    symbol: '◇',
    label: 'AI tokens',
    description: 'Text units processed in this session',
  },
  {
    tone: 'cost',
    symbol: '$',
    label: 'Estimated cost',
    description: 'Estimated AI usage cost for this session',
  },
  {
    tone: 'prompts',
    symbol: '↗',
    label: 'Prompts',
    description: 'Prompts submitted in this session',
  },
  {
    tone: 'activity',
    symbol: '●',
    label: 'Last activity',
    description: 'Time since the latest agent event',
  },
] as const;

export function MetricLegend() {
  return (
    <section className="metric-guide" aria-labelledby="metric-guide-title">
      <div className="metric-guide-title" id="metric-guide-title">
        Metric guide
      </div>
      <div className="metric-guide-items">
        {metrics.map((metric) => (
          <div className={`metric-guide-item metric-${metric.tone}`} key={metric.tone}>
            <span className="metric-guide-symbol" aria-hidden="true">
              {metric.symbol}
            </span>
            <span>
              <strong>{metric.label}</strong>
              <small>{metric.description}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
