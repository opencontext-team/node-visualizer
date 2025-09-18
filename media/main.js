// main.js - Node Visualizer Webview
// Converted from React components to vanilla JavaScript

// Global state
let networkInstance = null;
let nodeWeights = {};
let baselineNodeWeights = {};
let nodePositions = [];
let hoverNodeId = null;
let hoverHoldTimeout = null;
let isDirty = false;
let removedNodeIds = new Set();
let protectedNodeIds = new Set();
let sizedNodes = [];
let originalWeightByLabel = new Map();

// VSCode API for communication with extension
const vscode = acquireVsCodeApi();

// Constants
const PROTECTED_LABELS = new Set(["Agent"]);
const NODE_SIZE_MAP = { 1: 14, 2: 18, 3: 24, 4: 30, 5: 36 };
const BUTTON_SIZE_MAP = { 1: 14, 2: 18, 3: 22, 4: 26, 5: 32 };

// Mock data (same as your React version)
async function loadMCPDataMock() {
  return new Promise((resolve) => {
    setTimeout(() => {
      const dataSources = [
        {
          name: "Google Search",
          description: "External web search results",
          weight: 2,
        },
        {
          name: "Agent",
          description: "Central orchestration layer",
          weight: 3,
        },
        {
          name: "Wikipedia",
          description: "Encyclopedic knowledge base",
          weight: 1,
        },
        {
          name: "Internal Docs",
          description: "Proprietary documentation corpus",
          weight: 2,
        },
        {
          name: "News API",
          description: "Latest news headlines feed",
          weight: 1,
        },
      ];
      const connections = [
        { model1: "Google Search", model2: "Wikipedia", weight: 1 },
        { model1: "Google Search", model2: "Agent", weight: 2 },
        { model1: "Agent", model2: "Internal Docs", weight: 2 },
        { model1: "Agent", model2: "News API", weight: 1 },
      ];
      resolve({ dataSources, connections });
    }, 100);
  });
}

// Utility functions (converted from graphUtils.ts)
function normalizeWeights(dataSources) {
  const weights = dataSources.map((m) => m.weight);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  return (w) => {
    if (maxW === minW) {
      return 1.0;
    }
    const linear = (w - minW) / (maxW - minW);
    return Math.sqrt(linear * 0.6 + 0.4);
  };
}

function createNetworkData(apiData) {
  const normalize = normalizeWeights(apiData.dataSources);
  const nodes = apiData.dataSources.map((m, i) => ({
    id: i + 1,
    label: m.name,
    title: `${m.description} (weight: ${m.weight})`,
    value: normalize(m.weight) * 5,
  }));

  const nameToId = new Map(apiData.dataSources.map((m, i) => [m.name, i + 1]));
  const edges = apiData.connections.map((c) => ({
    from: nameToId.get(c.model1),
    to: nameToId.get(c.model2),
    value: c.weight,
  }));

  return { nodes, edges };
}

function computeNodeSize(weight) {
  const w = Math.max(1, Math.min(5, weight));
  return NODE_SIZE_MAP[w];
}

function computeButtonDimensions(weight) {
  const w = Math.max(1, Math.min(5, weight));
  const size = BUTTON_SIZE_MAP[w];
  const fontSize = Math.round(size * 0.5);
  return { size, fontSize };
}

function buildSizedNodes(rawNodes, weightLookup) {
  return rawNodes.map((n, idx) => {
    const safeLabel =
      typeof n.label === "string" && n.label.length
        ? n.label
        : `Node ${idx + 1}`;
    const weight =
      weightLookup.get(safeLabel) || weightLookup.get(n.label) || 2;
    return {
      id: n.id,
      label: safeLabel,
      title: n.title || safeLabel,
      size: computeNodeSize(weight),
    };
  });
}

function projectNodePositions(
  network,
  sizedNodes,
  currentWeights,
  weightLookup
) {
  const positions = network.getPositions();
  const result = [];

  for (const [idStr, pos] of Object.entries(positions)) {
    if (!pos) {
      continue;
    }
    const nodeId = Number(idStr);

    try {
      const domPoint = network.canvasToDOM({ x: pos.x, y: pos.y });
      const nodeData = sizedNodes.find((n) => n.id === nodeId);
      if (!nodeData) {
        continue;
      }

      result.push({
        id: nodeId,
        x: domPoint.x,
        y: domPoint.y,
        label: nodeData.label,
        weight:
          currentWeights[nodeId] ?? (weightLookup.get(nodeData.label) || 2),
      });
    } catch (e) {
      console.warn("Failed to project node position:", e);
    }
  }

  return result;
}

function zoomToFill(network, container, fitMargin = 0.75, fitPaddingPx = 32) {
  try {
    const positions = network.getPositions();
    const nodeIds = Object.keys(positions);
    if (!nodeIds.length) {
      return;
    }

    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;

    for (const id of nodeIds) {
      const pos = positions[id];
      if (!pos) {
        continue;
      }
      if (pos.x < left) {
        left = pos.x;
      }
      if (pos.x > right) {
        right = pos.x;
      }
      if (pos.y < top) {
        top = pos.y;
      }
      if (pos.y > bottom) {
        bottom = pos.y;
      }
    }

    const width = right - left || 1;
    const height = bottom - top || 1;
    const cw = container.clientWidth || 1;
    const ch = container.clientHeight || 1;
    const pad = Math.max(0, fitPaddingPx);
    const innerW = Math.max(10, cw - 2 * pad);
    const innerH = Math.max(10, ch - 2 * pad);

    const scaleX = innerW / width;
    const scaleY = innerH / height;
    const marginFactor = Math.min(1, Math.max(0.4, fitMargin));
    const targetScale = Math.min(scaleX, scaleY) * marginFactor;

    const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
    network.moveTo({ position: center, scale: targetScale });
  } catch (e) {
    console.warn("Failed to zoom to fill:", e);
  }
}

// Network options
const baseNetworkOptions = {
  physics: { stabilization: true },
  nodes: {
    scaling: { min: 12, max: 26, label: { enabled: true, min: 10, max: 18 } },
    shape: "dot",
    font: { size: 14 },
  },
  edges: {
    scaling: { min: 1, max: 8 },
    smooth: { enabled: false, type: "dynamic", roundness: 0.4 },
    color: { color: "#666", highlight: "#ff9800" },
  },
  interaction: { hover: true },
};

// State management functions
function setDirty(dirty) {
  isDirty = dirty;
  const applyButton = document.getElementById("applyButton");
  if (applyButton) {
    applyButton.style.display = dirty ? "block" : "none";
  }
}

function setHoverNodeId(nodeId) {
  hoverNodeId = nodeId;
  updateOverlayButtons();
}

// Visual node manipulation
function visuallyRemoveNode(nodeId) {
  if (!networkInstance) {
    return;
  }
  try {
    networkInstance.body.data.nodes.update({
      id: nodeId,
      color: { background: "#f2f2f2", border: "#bbb" },
      font: { color: "#999" },
    });

    const connected = networkInstance.getConnectedEdges(nodeId) || [];
    networkInstance.body.data.edges.update(
      connected.map((eid) => ({ id: eid, color: { color: "#ccc" } }))
    );
  } catch (e) {
    console.warn("Failed to visually remove node:", e);
  }
}

function visuallyRestoreNode(nodeId) {
  if (!networkInstance) {
    return;
  }
  try {
    networkInstance.body.data.nodes.update({
      id: nodeId,
      color: undefined,
      font: undefined,
    });

    const connected = networkInstance.getConnectedEdges(nodeId) || [];
    networkInstance.body.data.edges.update(
      connected.map((eid) => ({ id: eid, color: undefined }))
    );
  } catch (e) {
    console.warn("Failed to restore node visuals:", e);
  }
}

// Weight adjustment
function adjustNodeWeight(id, delta) {
  if (protectedNodeIds.has(id)) {
    return;
  }

  const current = nodeWeights[id] ?? 2;
  const next = Math.max(1, Math.min(5, current + delta));
  if (next === current) {
    return;
  }

  nodeWeights[id] = next;

  // Update network node size
  if (networkInstance) {
    try {
      const size = computeNodeSize(next);
      networkInstance.body.data.nodes.update({ id, size });
    } catch (e) {
      console.warn("Failed to update node size:", e);
    }
  }

  // Check dirty state
  const isDirtyNow = Object.keys(nodeWeights).some(
    (k) => nodeWeights[Number(k)] !== baselineNodeWeights[Number(k)]
  );
  setDirty(isDirtyNow);
  updateOverlayPositions();
}

// Overlay positioning and button updates
function updateOverlayPositions() {
  if (!networkInstance) {
    return;
  }
  nodePositions = projectNodePositions(
    networkInstance,
    sizedNodes,
    nodeWeights,
    originalWeightByLabel
  );
  updateOverlayButtons();
}

function updateOverlayButtons() {
  const overlay = document.getElementById("overlay");
  if (!overlay) {
    return;
  }

  // Clear existing buttons
  overlay.innerHTML = "";

  if (hoverNodeId === null) {
    return;
  }

  // Find the hovered node position
  const nodePos = nodePositions.find((n) => n.id === hoverNodeId);
  if (!nodePos || protectedNodeIds.has(hoverNodeId)) {
    return;
  }

  const isRemoved = removedNodeIds.has(hoverNodeId);

  // Create button container
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "node-buttons";
  buttonContainer.style.left = nodePos.x + "px";
  buttonContainer.style.top = nodePos.y + "px";

  // Calculate button sizing (same logic as React version)
  const weightClamped = Math.max(1, Math.min(5, nodePos.weight));
  const baseNodePx = computeNodeSize(weightClamped);
  const scale = networkInstance.getScale?.() || 1;
  const effectiveDiameter = baseNodePx * scale;

  const GAP_PX = 2;
  const MIN_BTN_SIZE = 18;
  const adaptiveEdgeMargin = (d) => {
    if (d < 24) {
      return 3;
    }
    if (d < 36) {
      return 4;
    }
    if (d < 48) {
      return 5;
    }
    return 6;
  };
  const EDGE_MARGIN_PX = adaptiveEdgeMargin(effectiveDiameter);
  const showsTwo = !isRemoved;
  const perButtonBase = (effectiveDiameter - EDGE_MARGIN_PX * 2 - GAP_PX) / 2;
  let nodeBtnSize = showsTwo ? perButtonBase : perButtonBase * 1.08;
  nodeBtnSize *= 1.03;
  nodeBtnSize = Math.max(MIN_BTN_SIZE, Math.round(nodeBtnSize));
  const maxAllowed = Math.round(effectiveDiameter - EDGE_MARGIN_PX * 2);
  if (nodeBtnSize > maxAllowed) {
    nodeBtnSize = maxAllowed;
  }
  const fontSize = Math.max(11, Math.round(nodeBtnSize * 0.55));

  const btnStyle = `width: ${nodeBtnSize}px; height: ${nodeBtnSize}px; font-size: ${fontSize}px; line-height: ${
    nodeBtnSize - 2
  }px;`;

  const atMin = nodePos.weight <= 1;
  const atMax = nodePos.weight >= 5;

  // Create buttons
  if (!isRemoved) {
    if (atMin) {
      // Remove button (X)
      const removeBtn = document.createElement("button");
      removeBtn.className = "mini-btn danger-btn";
      removeBtn.style.cssText = btnStyle;
      removeBtn.innerHTML = "×";
      removeBtn.setAttribute(
        "aria-label",
        `Remove ${nodePos.label} from graph`
      );
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removedNodeIds.add(hoverNodeId);
        visuallyRemoveNode(hoverNodeId);
        setDirty(true);
        updateOverlayPositions();
      };
      buttonContainer.appendChild(removeBtn);
    } else {
      // Decrease button (-)
      const decreaseBtn = document.createElement("button");
      decreaseBtn.className = "mini-btn";
      decreaseBtn.style.cssText = btnStyle;
      decreaseBtn.innerHTML = "-";
      decreaseBtn.setAttribute(
        "aria-label",
        `Decrease weight of ${nodePos.label}`
      );
      decreaseBtn.onclick = (e) => {
        e.stopPropagation();
        adjustNodeWeight(hoverNodeId, -1);
      };
      buttonContainer.appendChild(decreaseBtn);
    }
  }

  // Increase/Restore button (+)
  const increaseBtn = document.createElement("button");
  increaseBtn.className = "mini-btn";
  increaseBtn.style.cssText = btnStyle;
  increaseBtn.innerHTML = "+";
  increaseBtn.disabled = !isRemoved && atMax;
  increaseBtn.setAttribute(
    "aria-label",
    isRemoved
      ? `Restore ${nodePos.label}`
      : `Increase weight of ${nodePos.label}`
  );
  increaseBtn.onclick = (e) => {
    e.stopPropagation();
    if (isRemoved) {
      removedNodeIds.delete(hoverNodeId);
      visuallyRestoreNode(hoverNodeId);
      nodeWeights[hoverNodeId] = Math.max(nodeWeights[hoverNodeId] || 2, 2);

      if (networkInstance) {
        try {
          const size = computeNodeSize(nodeWeights[hoverNodeId]);
          networkInstance.body.data.nodes.update({ id: hoverNodeId, size });
        } catch (e) {
          console.warn("Failed to update restored node:", e);
        }
      }
      setDirty(true);
      updateOverlayPositions();
    } else {
      adjustNodeWeight(hoverNodeId, 1);
    }
  };
  buttonContainer.appendChild(increaseBtn);

  // Add hover event handlers to maintain button visibility
  buttonContainer.onmouseenter = () => {
    if (hoverHoldTimeout) {
      clearTimeout(hoverHoldTimeout);
      hoverHoldTimeout = null;
    }
    setHoverNodeId(hoverNodeId);
  };

  buttonContainer.onmouseleave = () => {
    if (hoverHoldTimeout) {
      clearTimeout(hoverHoldTimeout);
    }
    hoverHoldTimeout = setTimeout(() => setHoverNodeId(null), 150);
  };

  overlay.appendChild(buttonContainer);
}

// Network initialization
async function initializeNetwork() {
  try {
    const apiData = await loadMCPDataMock();
    const data = createNetworkData(apiData);

    // Set up weight lookup
    originalWeightByLabel = new Map(
      apiData.dataSources.map((ds) => [ds.name, ds.weight])
    );

    // Create sized nodes
    sizedNodes = buildSizedNodes(data.nodes, originalWeightByLabel);

    // Initialize weight state
    nodeWeights = {};
    for (const ds of apiData.dataSources) {
      const nodeEntry = sizedNodes.find((n) => n.label === ds.name);
      if (nodeEntry) {
        nodeWeights[nodeEntry.id] = ds.weight;
        if (PROTECTED_LABELS.has(ds.name)) {
          protectedNodeIds.add(nodeEntry.id);
        }
      }
    }
    baselineNodeWeights = { ...nodeWeights };

    // Create network
    const container = document.getElementById("network");
    networkInstance = new vis.Network(
      container,
      { nodes: sizedNodes, edges: data.edges },
      baseNetworkOptions
    );

    // Set up event handlers
    networkInstance.on("hoverNode", (params) => {
      setHoverNodeId(params.node);
      if (hoverHoldTimeout) {
        clearTimeout(hoverHoldTimeout);
        hoverHoldTimeout = null;
      }
    });

    networkInstance.on("blurNode", () => {
      if (hoverHoldTimeout) {
        clearTimeout(hoverHoldTimeout);
      }
      hoverHoldTimeout = setTimeout(() => setHoverNodeId(null), 250);
    });

    // Handle mouse movement to maintain hover state
    container.addEventListener("mousemove", (e) => {
      if (!networkInstance || hoverNodeId === null) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const nodeAt = networkInstance.getNodeAt({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      if (nodeAt === hoverNodeId) {
        if (hoverHoldTimeout) {
          clearTimeout(hoverHoldTimeout);
          hoverHoldTimeout = null;
        }
        setHoverNodeId(nodeAt);
      }
    });

    // Auto-fit and position updates
    networkInstance.on("afterDrawing", updateOverlayPositions);
    networkInstance.on("stabilized", () => {
      updateOverlayPositions();
      zoomToFill(networkInstance, container);
      networkInstance.setOptions({ physics: { enabled: false } });
    });

    // Initial position update
    setTimeout(updateOverlayPositions, 100);

    // Window resize handler
    let resizeTimer;
    window.addEventListener("resize", () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        zoomToFill(networkInstance, container);
      }, 120);
    });

    console.log("Network initialized successfully");
  } catch (error) {
    console.error("Failed to initialize network:", error);
    vscode.postMessage({
      type: "alert",
      text: "Failed to initialize network: " + error.message,
    });
  }
}

// Apply button handler
function initializeApplyButton() {
  const applyButton = document.getElementById("applyButton");
  if (applyButton) {
    applyButton.onclick = () => {
      console.log("Apply & Rerun with weights", nodeWeights);

      // Send message to extension
      vscode.postMessage({
        type: "applyChanges",
        weights: nodeWeights,
      });

      // Reset baseline and dirty state
      baselineNodeWeights = { ...nodeWeights };

      // Restore any removed nodes since changes are applied
      if (removedNodeIds.size) {
        removedNodeIds.forEach((id) => visuallyRestoreNode(id));
        removedNodeIds.clear();
      }

      setDirty(false);
    };
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  initializeNetwork();
  initializeApplyButton();
});

// Handle messages from extension
window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "refresh":
      // Reload the network data
      initializeNetwork();
      break;
  }
});
