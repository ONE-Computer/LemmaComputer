import "./AiControlPlane.css";

export const aiControlPlaneTabs = [
  { id: "overview", label: "Overview" },
  { id: "models-providers", label: "Models & routing" },
  { id: "teams-budgets", label: "Teams & budgets" },
  { id: "data-health", label: "Data health" },
];

export function AiControlPlane({ activeView, onViewChange, tabs = aiControlPlaneTabs, children }) {
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
        {tabs.map((tab) => (
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
