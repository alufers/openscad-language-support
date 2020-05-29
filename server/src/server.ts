import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  TextEdit,
  Range,
  Position,
  SymbolKind,
  DocumentSymbol,
} from "vscode-languageserver";

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CodeFile,
  ErrorCollector,
  Lexer,
  Token,
  Parser,
  FormattingConfiguration,
  ASTPrinter,
  ParsingHelper,
  CodeLocation,
  ASTScopePopulator,
  Scope,
  CompletionUtil,
  CompletionType,
  PreludeUtil,
  SolutionManager,
} from "openscad-parser";
import { uriToFilePath } from "vscode-languageserver/lib/files";

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

  // Revalidate all open text documents
  documents.all().forEach(validateScadFile);
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

const solutionManager = new SolutionManager();

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
  solutionManager.notifyFileClosed(uriToPath(e.document.uri), "xD");
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  if (!solutionManager.getFile(change.document.uri)) {
    solutionManager.notifyNewFileOpened(
      change.document.uri,
      change.document.getText()
    );
  } else {
    solutionManager.notifyFileChanged(
      change.document.uri,
      change.document.getText()
    );
  }
  validateScadFile(change.document);
});

async function validateScadFile(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  let settings = await getDocumentSettings(textDocument.uri);

  const file = new CodeFile(textDocument.uri, textDocument.getText());
  const errorCollector = new ErrorCollector();
  const lexer = new Lexer(file, errorCollector);
  let tokens: Token[] = [];
  try {
    tokens = lexer.scan();
  } catch (e) {}
  let parser, ast;
  if (!errorCollector.hasErrors()) {
    try {
      parser = new Parser(file, tokens, errorCollector);
      ast = parser.parse();
    } catch (e) {}
  }
  let diagnostics: Diagnostic[] = [];

  for (let error of errorCollector.errors) {
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

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log("We received an file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion((pos: TextDocumentPositionParams): CompletionItem[] => {
  try {
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      throw new Error("No document!");
    }
    const text = document.getText();
    const codeFile = new CodeFile(pos.textDocument.uri, text);
    const [ast, ec] = ParsingHelper.parseFile(codeFile);

    if (!ast) return []; // lexing failed completely
    let charsBeforeTheLine = 0;
    let linesToGo = pos.position.line;
    while (linesToGo != 0 && charsBeforeTheLine < text.length) {
      if (text[charsBeforeTheLine] === "\n") {
        linesToGo--;
      }
      charsBeforeTheLine++;
    }
    const fullOffset = charsBeforeTheLine + pos.position.character;
    const loc = new CodeLocation(
      codeFile,
      fullOffset,
      pos.position.line,
      pos.position.character
    );
    const scope = new Scope();
    scope.siblingScopes.push(PreludeUtil.preludeScope);
    const populator = new ASTScopePopulator(scope);
    const astWithScopes = ast.accept(populator);

    const symbols = CompletionUtil.getSymbolsAtLocation(astWithScopes, loc);
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
});

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    throw new Error("No document!");
  }
  const file = new CodeFile(document.uri, document.getText());
  const [ast, ec] = ParsingHelper.parseFile(file);
  ec.throwIfAny();
  return [
    TextEdit.replace(
      Range.create(
        Position.create(0, 0),
        document.positionAt(document.getText().length)
      ),
      new ASTPrinter(new FormattingConfiguration()).visitScadFile(ast!)
    ),
  ];
});

connection.onDocumentSymbol((params) => {
  console.log("xD");
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    throw new Error("No document!");
  }
  const file = new CodeFile(document.uri, document.getText());
  const [ast, ec] = ParsingHelper.parseFile(file);
  if (ec.hasErrors()) {
    return [];
  }
  const s = new Scope();
  new ASTScopePopulator(s).visitScadFile(ast!);
  const symbols: DocumentSymbol[] = [];
  console.log(s.modules);
  s.modules.forEach((mod) => {
    symbols.push(
      DocumentSymbol.create(
        mod.name,
        undefined,
        SymbolKind.Module,
        Range.create(
          mod.tokens.moduleKeyword.pos.line,
          mod.tokens.moduleKeyword.pos.col,
          mod.stmt.pos.line,
          mod.stmt.pos.col
        ),
        Range.create(
          mod.tokens.name.pos.line,
          mod.tokens.name.pos.col,
          mod.tokens.name.end.line,
          mod.tokens.name.end.col
        )
      )
    );
  });
  s.functions.forEach((mod) => {
    symbols.push(
      DocumentSymbol.create(
        mod.name,
        undefined,
        SymbolKind.Function,
        Range.create(
          mod.tokens.functionKeyword.pos.line,
          mod.tokens.functionKeyword.pos.col,
          mod.expr.pos.line,
          mod.expr.pos.col
        ),
        Range.create(
          mod.tokens.name.pos.line,
          mod.tokens.name.pos.col,
          mod.tokens.name.end.line,
          mod.tokens.name.end.col
        )
      )
    );
  });
  console.log(symbols);
  return symbols;
});

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
