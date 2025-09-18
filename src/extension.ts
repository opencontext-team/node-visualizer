// src/extension.ts
import * as vscode from "vscode";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  // Register the command to show the node visualizer
  let disposable = vscode.commands.registerCommand(
    "node-visualizer.start",
    () => {
      NodeVisualizerPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(disposable);
}

/**
 * Manages the webview panel for the node visualizer
 */
class NodeVisualizerPanel {
  public static currentPanel: NodeVisualizerPanel | undefined;
  public static readonly viewType = "nodeVisualizer";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (NodeVisualizerPanel.currentPanel) {
      NodeVisualizerPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      NodeVisualizerPanel.viewType,
      "Node Visualizer",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
          vscode.Uri.joinPath(extensionUri, "node_modules", "vis-network"),
          vscode.Uri.joinPath(extensionUri, "node_modules", "vis-data"),
        ],
      }
    );

    NodeVisualizerPanel.currentPanel = new NodeVisualizerPanel(
      panel,
      extensionUri
    );
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case "alert":
            vscode.window.showInformationMessage(message.text);
            return;
          case "applyChanges":
            vscode.window.showInformationMessage(
              `Applying changes: ${JSON.stringify(message.weights)}`
            );
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    NodeVisualizerPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update() {
    const webview = this._panel.webview;
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );

    // Get path to vis-network
    const visNetworkUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "vis-network",
        "standalone",
        "umd",
        "vis-network.min.js"
      )
    );

    // Get path to CSS file
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "styles.css")
    );

    // Use a nonce to only allow a specific script to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
            <link href="${stylesUri}" rel="stylesheet">
            <title>Node Visualizer</title>
        </head>
        <body>
            <div class="container">
                <header class="header">
                    <h1>MCP Visualization</h1>
                </header>
                <main class="main">
                    <div id="network" class="network-container"></div>
                    <div id="overlay" class="overlay-layer"></div>
                    <button id="applyButton" class="apply-button" style="display: none;">
                        Apply & Rerun
                    </button>
                </main>
            </div>

            <script nonce="${nonce}" src="${visNetworkUri}"></script>
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {}
