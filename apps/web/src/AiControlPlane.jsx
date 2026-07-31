import "./AiControlPlane.css";

export const aiControlPlaneTabs = [
  { id: "overview", label: "Overview" },
  { id: "models-providers", label: "Models & providers" },
  { id: "model-routes", label: "Model routes" },
  { id: "pricing", label: "Pricing" },
  { id: "teams-budgets", label: "Teams & budgets" },
  { id: "audit-log", label: "Audit log" },
];

export function AiControlPlane({ activeView, onViewChange, children }) {
  const activeTab = activeView === "spend" ? "overview" : activeView;

  return (
    <div className="secondary-screen ai-control-plane">
      <header className="ai-control-plane-header">
        <div>
          <p>Organization</p>
          <h1>AI control plane</h1>
          <span>Understand AI spend and manage the models, routes, pricing, and budgets behind every workspace.</span>
        </div>
      </header>
      <nav className="ai-control-plane-tabs" aria-label="AI control plane">
        {aiControlPlaneTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "active" : ""}
            aria-current={activeTab === tab.id ? "page" : undefined}
            onClick={() => onViewChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="ai-control-plane-content">
        {children}
      </div>
    </div>
  );
}

export function AiControlPlanePlaceholder({ title, description, actionLabel, onAction }) {
  const headingId = `ai-control-plane-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="ai-control-plane-placeholder" aria-labelledby={headingId}>
      <p>Organization controls</p>
      <h2 id={headingId}>{title}</h2>
      <span>{description}</span>
      {actionLabel && onAction && <button className="secondary-button" type="button" onClick={onAction}>{actionLabel}</button>}
    </section>
  );
}
