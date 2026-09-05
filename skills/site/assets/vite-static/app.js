async function renderDashboard() {
  const response = await fetch("./data/snapshot.json");
  const snapshot = await response.json();
  document.querySelector("#metrics").replaceChildren(...snapshot.metrics.map((metric) => {
    const card = document.createElement("article");
    card.className = "metric";
    const label = document.createElement("span");
    label.textContent = metric.label;
    const value = document.createElement("strong");
    value.textContent = metric.value;
    card.append(label, value);
    return card;
  }));
}

renderDashboard();
