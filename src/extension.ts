import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "extension.showHtmlButton",
    () => {
      const panel = vscode.window.createWebviewPanel(
        "htmlButton", // Identifies the type of the webview. Used internally
        "HTML Button", // Title of the panel displayed to the user
        vscode.ViewColumn.One, // Editor column to show the new webview panel in.
        {} // Webview options
      );

      panel.webview.html = getWebviewContent();
    }
  );

  context.subscriptions.push(disposable);
}

function getWebviewContent() {
  return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>HTML Button</title>
        </head>
        <body>
            <button onclick="alert('Button clicked!')">Click Me</button>
        </body>
        </html>
    `;
}

export function deactivate() {}
