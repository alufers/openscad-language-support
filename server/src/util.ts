import { SolutionFile, CodeLocation, SolutionManager } from "openscad-parser";
import {
  TextDocumentPositionParams,
  TextDocuments,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";


export function uriToPath(uri: string) {
  return uri.replace(/^file:\/\//, "");
}

export function pathToUri(path: string) {
  return "file://" + path;
}

export async function posToCodeLocation(
  solutionManager: SolutionManager,
  pos: TextDocumentPositionParams,
  documents: TextDocuments<TextDocument>
): Promise<[CodeLocation, SolutionFile]> {
  const document = documents.get(pos.textDocument.uri);
  if (!document) {
    throw new Error("No document!");
  }
  const solutionFile = await solutionManager.getFile(uriToPath(document.uri));
  if (!solutionFile || !solutionFile.ast) throw new Error("no ast");

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
  return [loc, solutionFile];
}
