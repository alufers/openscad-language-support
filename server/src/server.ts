import {
  ASTNode,
  ASTPinpointer,
  CodeError,
  CodeLocation,
  CompletionType,
  SolutionManager,
  SymbolKind as ScadSymbolKind,
} from "openscad-parser";
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  DefinitionParams,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DocumentSymbol,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  ProposedFeatures,
  Range,
  SymbolKind,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
  let capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentFormattingProvider: true,
      documentSymbolProvider: true,
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: true,
      },
      definitionProvider: true,
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "languageServerExample",
    });
    documentSettings.set(resource, result);
  }
  return result;
}

function uriToPath(uri: string) {
  return uri.replace(/^file:\/\//, "");
}

function pathToUri(path: string) {
  return "file://" + path;
}

const solutionManager = new SolutionManager();

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
  solutionManager.notifyFileClosed(uriToPath(e.document.uri));
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async (change) => {
  const solutionFile = await solutionManager.getFile(
    uriToPath(change.document.uri)
  );
  if (!solutionFile) {
    await solutionManager.notifyNewFileOpened(
      uriToPath(change.document.uri),
      change.document.getText()
    );
  } else {
    await solutionManager.notifyFileChanged(
      uriToPath(change.document.uri),
      change.document.getText()
    );
  }

  if (solutionFile) {
    const textDocument = change.document;
    let diagnostics: Diagnostic[] = [];
    for (let error of solutionFile.errors as CodeError[]) {
      let diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: textDocument.positionAt(error.codeLocation.char),
          end: textDocument.positionAt(error.codeLocation.char),
        },
        message: error.message,
        source: "openscad-language-support",
      };
      diagnostics.push(diagnostic);
    }

    // Send the computed diagnostics to VSCode.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  }
});

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log("We received an file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    try {
      const document = documents.get(pos.textDocument.uri);
      if (!document) {
        throw new Error("No document!");
      }
      const solutionFile = await solutionManager.getFile(
        uriToPath(document.uri)
      );
      if (!solutionFile || !solutionFile.ast) return [];

      const text = document.getText();
      let charsBeforeTheLine = 0;
      let linesToGo = pos.position.line;
      while (linesToGo != 0 && charsBeforeTheLine < text.length) {
        if (text[charsBeforeTheLine] === "\n") {
          linesToGo--;
        }
        charsBeforeTheLine++;
      }
      let fullOffset = charsBeforeTheLine + pos.position.character;
      if (fullOffset >= text.length) {
        fullOffset = text.length > 0 ? text.length - 1 : 0;
      }
      const loc = new CodeLocation(
        solutionFile.ast.pos.file,
        fullOffset,
        pos.position.line,
        pos.position.character
      );
      const symbols = await solutionFile.getCompletionsAtLocation(loc);
      return symbols.map((s, i) => {
        let kind: CompletionItemKind = CompletionItemKind.Text;
        switch (s.type) {
          case CompletionType.FUNCTION:
            kind = CompletionItemKind.Function;
            break;
          case CompletionType.MODULE:
            kind = CompletionItemKind.Module;
            break;
          case CompletionType.VARIABLE:
            kind = CompletionItemKind.Variable;
            break;
          case CompletionType.KEYWORD:
            kind = CompletionItemKind.Keyword;
            break;
          case CompletionType.DIRECTORY:
            kind = CompletionItemKind.Folder;
            break;
          case CompletionType.FILE:
            kind = CompletionItemKind.File;
            break;
        }
        return {
          label: s.name,
          kind,
          data: i + 1,
        };
      });
    } catch (e) {
      console.log(e);
      console.log(e.stack);
      throw e;
    }
  }
);

connection.onDocumentFormatting(async (params) => {
  const f = await solutionManager.getFile(uriToPath(params.textDocument.uri));
  if (f.errors.length > 0) {
    return [];
  }
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    throw new Error("No document!");
  }
  return [
    TextEdit.replace(
      Range.create(
        Position.create(0, 0),
        document.positionAt(document.getText().length)
      ),
      f.getFormatted()
    ),
  ];
});

connection.onDocumentSymbol(async (params) => {
  try {
    const solutionFile = await solutionManager.getFile(
      uriToPath(params.textDocument.uri)
    );

    return solutionFile.getSymbols<DocumentSymbol>(
      (name, kind, fullRange, nameRange, children) => {
        let k: SymbolKind;
        switch (kind) {
          case ScadSymbolKind.FUNCTION:
            k = SymbolKind.Function;
            break;
          case ScadSymbolKind.MODULE:
            k = SymbolKind.Module;
            break;
          case ScadSymbolKind.VARIABLE:
            k = SymbolKind.Variable;
            break;
        }
        return DocumentSymbol.create(
          name,
          undefined,
          k,
          Range.create(
            Position.create(fullRange.start.line, fullRange.start.col),
            Position.create(fullRange.end.line, fullRange.end.col)
          ),
          Range.create(
            Position.create(nameRange.start.line, nameRange.start.col),
            Position.create(nameRange.end.line, nameRange.end.col)
          ),
          children
        );
      }
    );
  } catch (e) {
    console.log(e);
    console.log(e.stack);
    console.log("---END OF SYMBOL ERROR---");
    throw e;
  }
});

connection.onDefinition(
  async (pos: DefinitionParams): Promise<Location | null> => {
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      throw new Error("No document!");
    }
    const solutionFile = await solutionManager.getFile(uriToPath(document.uri));
    if (!solutionFile || !solutionFile.ast) throw new Error("File not opened.");

    const text = document.getText();
    let charsBeforeTheLine = 0;
    let linesToGo = pos.position.line;
    while (linesToGo != 0 && charsBeforeTheLine < text.length) {
      if (text[charsBeforeTheLine] === "\n") {
        linesToGo--;
      }
      charsBeforeTheLine++;
    }
    let fullOffset = charsBeforeTheLine + pos.position.character;
    if (fullOffset >= text.length) {
      fullOffset = text.length > 0 ? text.length - 1 : 0;
    }
    const loc = new CodeLocation(
      solutionFile.ast.pos.file,
      fullOffset,
      pos.position.line,
      pos.position.character
    );
    const defLoc = solutionFile.getSymbolDefinition(loc);
    if (!defLoc) {
      return null;
    
    }
    return Location.create(
      pathToUri(defLoc.file.path),
      Range.create(
        Position.create(defLoc.line, defLoc.col),
        Position.create(defLoc.line, defLoc.col)
      )
    );
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = "module";
      item.documentation = "A module";
    } else if (item.data === 2) {
      item.detail = "function";
      item.documentation = "A function";
    }
    return item;
  }
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
