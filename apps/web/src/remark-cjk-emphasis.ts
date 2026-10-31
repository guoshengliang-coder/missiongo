interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Repair only otherwise-literal CJK emphasis; the Markdown parser owns code,
 * escapes, links and every already-recognized formatting construct. */
export function remarkCjkEmphasis() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: MarkdownNode) => {
      if (!parent.children || ["code", "inlineCode", "html"].includes(parent.type)) return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "text" || !node.value) { visit(node); return [node]; }
        const { start, end } = node.position ?? {};
        // Escaped/entity-decoded text is intentionally left to the parser.
        if (source.slice(start?.offset, end?.offset) !== node.value) return [node];
        const result: MarkdownNode[] = [];
        const pattern = /(?<![*_])(\*{1,2}|_{1,2})(?![\s*_])([^*_\n]+?)\1(?![*_])/gu;
        let offset = 0;
        for (const match of node.value.matchAll(pattern)) {
          const content = match[2]!.trimEnd();
          if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(content)) continue;
          // Underscores inside words retain CommonMark's literal meaning.
          if (match[1]!.startsWith("_") && /[\p{L}\p{N}]/u.test(node.value[match.index - 1] ?? "")) continue;
          if (match.index > offset) result.push({ type: "text", value: node.value.slice(offset, match.index) });
          result.push({ type: match[1]!.length === 2 ? "strong" : "emphasis", children: [{ type: "text", value: content }] });
          const trailing = match[2]!.slice(content.length);
          if (trailing) result.push({ type: "text", value: trailing });
          offset = match.index + match[0].length;
        }
        if (!result.length) return [node];
        if (offset < node.value.length) result.push({ type: "text", value: node.value.slice(offset) });
        return result;
      });
    };
    visit(tree);
  };
}
