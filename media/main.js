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
// needs to be able to accept data from text file
// then we parse them down into the arrays
async function loadMCPDataMock() {
  return new Promise((resolve) => {
    setTimeout(() => {
      const dataSources = window.rawVisData
        .filter((item) => item.type === "entity")
        .map((item) => {
          // conclusion nodes get weight 3
          const isConclusion = item.entityType === "conclusion";
          const weight = isConclusion ? 3 : 1;

          return {
            name: item.name,
            description: item.observations ? item.observations.join(" ") : "",
            weight: weight,
          };
        });

      // protect conclusion nodes from deletion
      dataSources.forEach((ds) => {
        const entity = window.rawVisData.find(
          (item) => item.type === "entity" && item.name === ds.name
        );
        if (entity && entity.entityType === "conclusion") {
          PROTECTED_LABELS.add(ds.name);
        }
      });

      const connections = window.rawVisData
        .filter((item) => item.type === "relation")
        .map((item) => {
          // Get entity types for from and to nodes
          const fromEntity = window.rawVisData.find(
            (entity) => entity.type === "entity" && entity.name === item.from
          );
          const toEntity = window.rawVisData.find(
            (entity) => entity.type === "entity" && entity.name === item.to
          );

          const fromIsConclusion = fromEntity?.entityType === "conclusion";
          const toIsConclusion = toEntity?.entityType === "conclusion";

          // Reverse direction for specific relation types to make logical sense:
          let shouldReverse = false;

          if (item.relationType === "based_on") {
            shouldReverse = true; // Files → Conclusions
          } else if (fromIsConclusion && toIsConclusion) {
            // For conclusion-to-conclusion relationships, reverse most of them
            // to create a more logical narrative flow
            if (
              ["extends", "contrasts", "contrasts_with"].includes(
                item.relationType
              )
            ) {
              shouldReverse = true; // Base/source conclusion → Extended/compared conclusion
            }
            // Keep "leads_to", "enables", "requires" in original direction
          }

          // Add some debugging
          if (fromIsConclusion && toIsConclusion) {
            console.log(
              `Conclusion relation: ${item.from} --${item.relationType}--> ${item.to} (reverse: ${shouldReverse})`
            );
          }

          return {
            model1: shouldReverse ? item.to : item.from,
            model2: shouldReverse ? item.from : item.to,
            weight: 1,
            relationType: item.relationType, // Keep relation type for debugging
            fromIsConclusion: shouldReverse ? toIsConclusion : fromIsConclusion,
            toIsConclusion: shouldReverse ? fromIsConclusion : toIsConclusion,
          };
        })
        .filter((connection) => {
          // FILTER OUT: Remove any edges that start from a conclusion node
          // This ensures pink conclusion nodes never have outgoing arrows
          if (connection.fromIsConclusion) {
            console.log(
              `Filtered out outgoing edge from conclusion: ${connection.model1} → ${connection.model2}`
            );
            return false;
          }
          return true;
        });
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
  physics: {
    stabilization: {
      enabled: true,
      iterations: 100,
      updateInterval: 50,
    },
    forceAtlas2Based: {
      gravitationalConstant: -80,
      centralGravity: 0.02,
      springConstant: 0.05,
      springLength: 250,
      damping: 0.5,
      avoidOverlap: 1,
    },
    maxVelocity: 30,
    minVelocity: 0.1,
    solver: "forceAtlas2Based",
    adaptiveTimestep: true,
  },
  nodes: {
    scaling: { min: 15, max: 35, label: { enabled: true, min: 12, max: 20 } },
    shape: "dot",
    font: {
      size: 13,
      color: "#ffffff",
      face: "arial",
      strokeWidth: 1,
      strokeColor: "#000000",
    },
    margin: 25,
    widthConstraint: { maximum: 250 },
    chosen: {
      node: function (values, id, selected, hovering) {
        if (hovering) {
          values.size = values.size * 1.1;
          values.borderWidth = 3;
        }
      },
    },
  },
  edges: {
    scaling: { min: 0.5, max: 2 }, // Reduced from min: 1, max: 6 - thinner lines
    width: 1, // Set base line width to 1 (thin)
    smooth: {
      enabled: true,
      type: "dynamic",
      roundness: 0.3,
      forceDirection: "none",
    },
    color: { color: "#ffffff", highlight: "#ffffff", opacity: 0.8 },
    arrows: {
      to: { enabled: true, scaleFactor: 0.4 }, // Reduced from 0.8 - smaller arrows
    },
  },
  interaction: {
    hover: true,
    tooltipDelay: 200,
    zoomView: true,
    dragView: true,
  },
  layout: {
    improvedLayout: false,
    clusterThreshold: 100,
    hierarchical: {
      enabled: true,
      levelSeparation: 200, // Reduced horizontal spacing (was 300)
      nodeSpacing: 150, // Reduced vertical spacing (was 200)
      treeSpacing: 200, // Reduced tree spacing (was 300)
      blockShifting: true, // Re-enable to allow more compact layout
      edgeMinimization: true, // Re-enable to reduce crossings
      parentCentralization: true, // Re-enable for better organization
      direction: "LR", // Keep Left-to-Right
      sortMethod: "directed",
    },
  },
};

// Hierarchical Layout Functions
function calculateHierarchyLevels(nodes, edges) {
  console.log("Calculating hierarchy levels...");

  // Create adjacency maps
  const incomingEdges = new Map(); // nodeId -> array of source nodes
  const outgoingEdges = new Map(); // nodeId -> array of target nodes

  // Initialize maps
  nodes.forEach((node) => {
    incomingEdges.set(node.id, []);
    outgoingEdges.set(node.id, []);
  });

  // Populate edge maps
  edges.forEach((edge) => {
    if (outgoingEdges.has(edge.from)) {
      outgoingEdges.get(edge.from).push(edge.to);
    }
    if (incomingEdges.has(edge.to)) {
      incomingEdges.get(edge.to).push(edge.from);
    }
  });

  // Find nodes by connection type
  const rootNodes = []; // No incoming connections (top level)
  const leafNodes = []; // No outgoing connections (bottom level)
  const connectedNodes = []; // Has both incoming and outgoing
  const isolatedNodes = []; // No connections at all

  nodes.forEach((node) => {
    const incoming = incomingEdges.get(node.id).length;
    const outgoing = outgoingEdges.get(node.id).length;

    if (incoming === 0 && outgoing === 0) {
      isolatedNodes.push(node);
    } else if (incoming === 0) {
      rootNodes.push(node);
    } else if (outgoing === 0) {
      leafNodes.push(node);
    } else {
      connectedNodes.push(node);
    }
  });

  console.log("Node categorization:", {
    roots: rootNodes.length,
    leaves: leafNodes.length,
    connected: connectedNodes.length,
    isolated: isolatedNodes.length,
  });

  // Calculate levels using topological sort approach
  const levels = new Map(); // nodeId -> level number
  const visited = new Set();

  // Level 0: Root nodes (no incoming connections)
  rootNodes.forEach((node) => {
    levels.set(node.id, 0);
    visited.add(node.id);
  });

  // BFS to assign levels
  const queue = [...rootNodes.map((n) => n.id)];
  let maxLevel = 0;

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    const currentLevel = levels.get(currentNodeId);

    // Process outgoing connections
    const outgoing = outgoingEdges.get(currentNodeId) || [];
    outgoing.forEach((targetId) => {
      if (!visited.has(targetId)) {
        const targetLevel = currentLevel + 1;
        levels.set(targetId, targetLevel);
        visited.add(targetId);
        queue.push(targetId);
        maxLevel = Math.max(maxLevel, targetLevel);
      }
    });
  }

  // Handle any remaining unvisited connected nodes (cycles or disconnected components)
  connectedNodes.forEach((node) => {
    if (!visited.has(node.id)) {
      // Place in middle levels
      const midLevel = Math.floor(maxLevel / 2);
      levels.set(node.id, midLevel);
      visited.add(node.id);
    }
  });

  // Group nodes by level
  const nodesByLevel = new Map();
  for (let i = 0; i <= maxLevel; i++) {
    nodesByLevel.set(i, []);
  }

  nodes.forEach((node) => {
    if (levels.has(node.id)) {
      const level = levels.get(node.id);
      nodesByLevel.get(level).push(node);
    }
  });

  console.log("Hierarchy levels calculated:", {
    maxLevel,
    nodesByLevel: Array.from(nodesByLevel.entries()).map(([level, nodes]) => ({
      level,
      count: nodes.length,
      nodes: nodes.map((n) => n.label),
    })),
  });

  return { nodesByLevel, isolatedNodes, maxLevel };
}

function applyHierarchicalLayout(nodes, edges, networkInstance) {
  console.log("Applying hierarchical layout...");

  const { nodesByLevel, isolatedNodes, maxLevel } = calculateHierarchyLevels(
    nodes,
    edges
  );

  // Calculate layout dimensions
  const container = document.getElementById("network");
  const containerWidth = container.clientWidth || 800;
  const containerHeight = container.clientHeight || 600;

  const levelHeight = Math.max(120, containerHeight / (maxLevel + 2)); // Space between levels
  const startY = -((maxLevel * levelHeight) / 2); // Center vertically

  const positions = {};

  // Position nodes by hierarchy level
  for (let level = 0; level <= maxLevel; level++) {
    const nodesInLevel = nodesByLevel.get(level) || [];
    if (nodesInLevel.length === 0) {
      continue;
    }

    const y = startY + level * levelHeight;
    const levelWidth = Math.min(
      containerWidth * 0.8,
      nodesInLevel.length * 150
    );
    const nodeSpacing = levelWidth / Math.max(1, nodesInLevel.length - 1);
    const startX = -(levelWidth / 2);

    nodesInLevel.forEach((node, index) => {
      const x = nodesInLevel.length === 1 ? 0 : startX + index * nodeSpacing;
      positions[node.id] = { x, y };
    });
  }

  // Position isolated nodes separately (right side)
  const isolatedStartX = containerWidth * 0.3;
  const isolatedSpacing = 80;
  isolatedNodes.forEach((node, index) => {
    const x = isolatedStartX;
    const y =
      -((isolatedNodes.length * isolatedSpacing) / 2) + index * isolatedSpacing;
    positions[node.id] = { x, y };
  });

  console.log(
    "Calculated positions for",
    Object.keys(positions).length,
    "nodes"
  );

  // Apply positions to network
  networkInstance.setPositions(positions);

  // Disable physics temporarily while positioning
  networkInstance.setOptions({
    physics: { enabled: false },
  });

  // Re-enable physics after positioning with reduced strength
  setTimeout(() => {
    networkInstance.setOptions({
      physics: {
        enabled: true,
        stabilization: { enabled: false },
        forceAtlas2Based: {
          gravitationalConstant: -30, // Reduced from -80
          centralGravity: 0.01, // Reduced from 0.02
          springConstant: 0.02, // Reduced from 0.05
          springLength: 200, // Reduced from 250
          damping: 0.7, // Increased from 0.5
          avoidOverlap: 1,
        },
        maxVelocity: 15, // Reduced from 30
        minVelocity: 0.1,
        solver: "forceAtlas2Based",
      },
    });
  }, 1000);
}

// Function to identify isolated nodes and position them separately
function positionIsolatedNodes(nodes, edges, networkInstance) {
  console.log("positionIsolatedNodes called with:", {
    nodesCount: nodes.length,
    edgesCount: edges.length,
  });

  // Find nodes that have no connections
  const connectedNodeIds = new Set();
  edges.forEach((edge) => {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  });

  console.log("Connected node IDs:", Array.from(connectedNodeIds));
  console.log(
    "All node IDs:",
    nodes.map((n) => n.id)
  );

  const isolatedNodes = nodes.filter((node) => !connectedNodeIds.has(node.id));

  console.log(
    "Isolated nodes found:",
    isolatedNodes.map((n) => ({ id: n.id, label: n.label }))
  );

  if (isolatedNodes.length === 0) {
    console.log("No isolated nodes found, returning");
    return;
  }

  // Wait for initial stabilization, then position isolated nodes
  setTimeout(() => {
    console.log("Positioning isolated nodes after timeout");
    const positions = networkInstance.getPositions();
    const connectedPositions = Object.entries(positions)
      .filter(([id]) => connectedNodeIds.has(Number(id)))
      .map(([id, pos]) => pos);

    console.log("Connected positions:", connectedPositions);

    if (connectedPositions.length === 0) {
      console.log("No connected positions found");
      return;
    }

    // Find the bounding box of the main connected component
    let minX = Math.min(...connectedPositions.map((p) => p.x));
    let maxX = Math.max(...connectedPositions.map((p) => p.x));
    let minY = Math.min(...connectedPositions.map((p) => p.y));
    let maxY = Math.max(...connectedPositions.map((p) => p.y));

    console.log("Bounding box:", { minX, maxX, minY, maxY });

    const padding = 400; // Distance from main graph (increased)
    const isolatedSpacing = 120; // Spacing between isolated nodes (decreased for more nodes)
    const maxPerColumn = 8; // Maximum nodes per column

    // Position isolated nodes in columns to the right of the main graph
    const isolatedPositions = {};
    isolatedNodes.forEach((node, index) => {
      const column = Math.floor(index / maxPerColumn);
      const row = index % maxPerColumn;

      isolatedPositions[node.id] = {
        x: maxX + padding + column * 300, // Multiple columns if needed
        y: minY + row * isolatedSpacing,
        fixed: { x: true, y: true }, // Fix position so physics doesn't move them
      };
    });

    console.log("Setting isolated positions:", isolatedPositions);

    // Apply the positions
    networkInstance.setPositions(isolatedPositions);

    // Update node data to show isolated nodes with different styling
    const isolatedNodeUpdates = isolatedNodes.map((node) => ({
      id: node.id,
      color: {
        background: "#f0f8ff",
        border: "#87ceeb",
        highlight: {
          background: "#e6f3ff",
          border: "#4682b4",
        },
      },
      font: {
        color: "#ffffff",
      },
    }));

    console.log("Updating isolated node styles:", isolatedNodeUpdates);
    networkInstance.body.data.nodes.update(isolatedNodeUpdates);

    // Re-fit the view to include isolated nodes
    setTimeout(() => {
      console.log("Re-fitting view");
      zoomToFill(networkInstance, document.getElementById("network"), 0.8, 50);
    }, 100);
  }, 1000);
}

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
  // Manually update positions when hover changes (instead of on every draw)
  updateOverlayPositions();
}

// Visual node manipulation
function visuallyRemoveNode(nodeId) {
  console.log("visuallyRemoveNode called for nodeId:", nodeId);
  if (!networkInstance) {
    console.log("No network instance available");
    return;
  }
  try {
    console.log("Updating node visual style to removed state");
    networkInstance.body.data.nodes.update({
      id: nodeId,
      color: { background: "#f2f2f2", border: "#bbb" },
      font: { color: "#999" },
    });

    const connected = networkInstance.getConnectedEdges(nodeId) || [];
    console.log("Connected edges to update:", connected);
    networkInstance.body.data.edges.update(
      connected.map((eid) => ({ id: eid, color: { color: "#ccc" } }))
    );
    console.log("Node visually removed successfully");
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

  // Don't recreate buttons if we're still hovering the same node
  if (overlay.dataset.currentNodeId === String(hoverNodeId)) {
    return;
  }

  // Clear existing buttons
  overlay.innerHTML = "";

  if (hoverNodeId === null) {
    overlay.dataset.currentNodeId = "";
    return;
  }

  // Find the hovered node position
  const nodePos = nodePositions.find((n) => n.id === hoverNodeId);
  if (!nodePos || protectedNodeIds.has(hoverNodeId)) {
    return;
  }

  // Set the current node ID to prevent recreation
  overlay.dataset.currentNodeId = String(hoverNodeId);

  const isRemoved = removedNodeIds.has(hoverNodeId);

  // Create button container
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "node-buttons";
  buttonContainer.style.left = nodePos.x + "px";
  buttonContainer.style.top = nodePos.y + "px";

  console.log(
    `Creating buttons for node ${nodePos.label} at position (${nodePos.x}, ${
      nodePos.y
    }), weight: ${nodePos.weight}, atMin: ${nodePos.weight <= 1}`
  );

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

      // Add mousedown and click handlers for debugging
      removeBtn.onmousedown = (e) => {
        console.log("Remove button mousedown:", hoverNodeId, nodePos.label);
        e.stopPropagation();
      };

      removeBtn.onclick = (e) => {
        console.log(
          "Remove button clicked for node:",
          hoverNodeId,
          nodePos.label
        );
        e.stopPropagation();
        e.preventDefault();
        removedNodeIds.add(hoverNodeId);
        visuallyRemoveNode(hoverNodeId);
        setDirty(true);
        updateOverlayPositions();
        console.log(
          "Node removed, removedNodeIds:",
          Array.from(removedNodeIds)
        );
      };

      // Make sure the button is interactive
      removeBtn.style.pointerEvents = "auto";
      removeBtn.style.cursor = "pointer";

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

    // Apply special styling for conclusion nodes
    const conclusionNodeUpdates = [];
    sizedNodes.forEach((node) => {
      const entity = window.rawVisData.find(
        (item) => item.type === "entity" && item.name === node.label
      );
      if (entity && entity.entityType === "conclusion") {
        conclusionNodeUpdates.push({
          id: node.id,
          color: {
            background: "#e91ea2ff", // Pink background
            border: "#d6266dff", // Darker pink border
            highlight: {
              background: "#f462c1ff", // Lighter pink on hover
              border: "#d6266dff", // Darker pink border on hover
            },
          },
          font: {
            color: "#ffffff",
            strokeWidth: 2,
            strokeColor: "#000000",
          },
        });
      }
    });

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

    // Apply conclusion node styling after network creation
    if (conclusionNodeUpdates.length > 0) {
      networkInstance.body.data.nodes.update(conclusionNodeUpdates);
    }

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
    const afterDrawingHandler = () => updateOverlayPositions();
    networkInstance.on("afterDrawing", afterDrawingHandler);

    networkInstance.on("stabilized", () => {
      updateOverlayPositions();
      // Built-in hierarchical layout is already applied
      zoomToFill(networkInstance, container);

      // Disable physics after initial layout to allow free dragging
      networkInstance.setOptions({
        physics: { enabled: false },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          zoomView: true,
          dragView: true,
          dragNodes: true, // Ensure node dragging is enabled
        },
      });

      // Remove the afterDrawing listener to stop constant updates
      networkInstance.off("afterDrawing", afterDrawingHandler);

      console.log(
        "Network stabilized, physics disabled, nodes can be dragged freely"
      );
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
  // Initialize chat window
  new ChatWindow();
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

// Chat Window Functionality
class ChatWindow {
  constructor() {
    this.messages = [];
    this.isMinimized = false;
    this.isTyping = false;
    this.chatWindow = document.getElementById("chatWindow");
    this.chatMessages = document.getElementById("chatMessages");
    this.chatInput = document.getElementById("chatInput");
    this.chatSend = document.getElementById("chatSend");
    this.chatToggle = document.getElementById("chatToggle");

    if (!this.chatWindow) {
      console.error("Chat window element not found!");
      return;
    }

    this.initializeEventListeners();
    this.loadInitialMessages();
  }
  initializeEventListeners() {
    // Send message on button click or Enter key
    this.chatSend.addEventListener("click", () => this.sendMessage());
    this.chatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.sendMessage();
      }
    });

    // Toggle minimize/maximize
    this.chatToggle.addEventListener("click", () => this.toggleMinimize());
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    this.chatWindow.classList.toggle("minimized", this.isMinimized);
    this.chatToggle.textContent = this.isMinimized ? "+" : "−";
  }

  addMessage(content, isUser = false, timestamp = new Date()) {
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${isUser ? "user" : "assistant"}`;

    const bubbleDiv = document.createElement("div");
    bubbleDiv.className = "message-bubble";
    bubbleDiv.textContent = content;

    const timeDiv = document.createElement("div");
    timeDiv.className = "message-time";
    timeDiv.textContent = timestamp.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    messageDiv.appendChild(bubbleDiv);
    messageDiv.appendChild(timeDiv);
    this.chatMessages.appendChild(messageDiv);

    // Scroll to bottom
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

    return messageDiv;
  }

  showTypingIndicator() {
    if (this.isTyping) {
      return;
    }
    this.isTyping = true;

    const typingDiv = document.createElement("div");
    typingDiv.className = "message assistant typing-message";

    const typingIndicator = document.createElement("div");
    typingIndicator.className = "typing-indicator";

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("div");
      dot.className = "typing-dot";
      typingIndicator.appendChild(dot);
    }

    typingDiv.appendChild(typingIndicator);
    this.chatMessages.appendChild(typingDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

    return typingDiv;
  }

  hideTypingIndicator(typingDiv) {
    if (typingDiv && typingDiv.parentNode) {
      typingDiv.parentNode.removeChild(typingDiv);
    }
    this.isTyping = false;
  }

  async sendMessage() {
    const message = this.chatInput.value.trim();
    if (!message) {
      return;
    }

    // Add user message
    this.addMessage(message, true);
    this.chatInput.value = "";

    // Show typing indicator
    const typingDiv = this.showTypingIndicator();

    // Simulate AI response delay
    setTimeout(() => {
      this.hideTypingIndicator(typingDiv);
      const response = this.generateMockResponse(message);
      this.addMessage(response, false);
    }, 1000 + Math.random() * 2000); // 1-3 second delay
  }

  generateMockResponse(userMessage) {
    const responses = [
      "The knowledge graph shows interconnected nodes representing different data sources and their relationships. Each node's size indicates its weight or importance in the system.",
      "I can see you're looking at the MCP visualization. The graph represents entities and their connections, with conclusion nodes highlighted in different colors.",
      "Based on the current graph structure, I notice several isolated nodes that aren't directly connected to the main component. These might represent standalone data sources.",
      "The network uses a force-directed layout algorithm to position nodes. Connected nodes are pulled together while maintaining readability through spacing.",
      "You can interact with the nodes using the overlay buttons to adjust weights or remove nodes from the visualization. Changes are tracked and can be applied with the 'Apply & Rerun' button.",
      "The graph appears to show a simplified system for calculating taxes, with entities like 'source.py' and functions for tax calculations. The relationships indicate data flow or dependencies.",
      "Each edge in the graph represents a connection or relationship between two entities. The thickness or color of edges can indicate the strength of the relationship.",
      "The visualization helps identify clusters, isolated components, and the overall structure of your knowledge graph. This is useful for understanding data relationships and dependencies.",
    ];

    // Simple keyword-based response selection
    const lowerMessage = userMessage.toLowerCase();
    if (lowerMessage.includes("node") || lowerMessage.includes("graph")) {
      return responses[Math.floor(Math.random() * 4)]; // First 4 responses
    } else if (
      lowerMessage.includes("connect") ||
      lowerMessage.includes("edge")
    ) {
      return responses[6]; // Edge-related response
    } else if (
      lowerMessage.includes("tax") ||
      lowerMessage.includes("calculate")
    ) {
      return responses[5]; // Tax calculation response
    } else {
      return responses[Math.floor(Math.random() * responses.length)];
    }
  }

  loadInitialMessages() {
    // Add initial welcome message
    setTimeout(() => {
      this.addMessage(
        "Hello! I'm OpenContext Agent, your AI assistant. How can I help you with the knowledge graph?",
        false,
        new Date(Date.now() - 60000) // 1 minute ago
      );
    }, 500);

    // Add a sample interaction
    setTimeout(() => {
      this.addMessage(
        "summarize the knowledge graph",
        true,
        new Date(Date.now() - 30000) // 30 seconds ago
      );
    }, 1000);

    setTimeout(() => {
      const typingDiv = this.showTypingIndicator();
      setTimeout(() => {
        this.hideTypingIndicator(typingDiv);
        this.addMessage(
          "The knowledge graph provided outlines a simplified system for calculating taxes, primarily focusing on a single file named 'source.py' and a function within it called 'calculate_tax()'. Here's a summary of the information:",
          false,
          new Date(Date.now() - 25000) // 25 seconds ago
        );
      }, 1500);
    }, 1200);
  }
}
