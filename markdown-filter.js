/**
 * markdown-filter.js — 流式 Markdown 过滤器
 *
 * 从 @tencent-weixin/openclaw-weixin 移植（v2.4.1）
 * 完全自包含，零外部依赖，可直接复制使用。
 *
 * 功能：将 AI 输出的 Markdown 转为微信可显示的纯文本
 * — 保留：代码块、行内代码、表格、分割线、粗体、英文斜体
 * — 过滤：中文字符周围的斜体标记、H5/H6 标题标记
 * — 删除：图片 ![](url)
 *
 * 设计为字符级流式状态机，适合 token-by-token 的 AI 流式输出：
 *   const f = new StreamingMarkdownFilter()
 *   for (const chunk of aiStream) {
 *     output(f.feed(chunk))  // 尽可能多地输出已处理的文字
 *   }
 *   output(f.flush())        // 输出剩余的缓冲
 */

export class StreamingMarkdownFilter {
  constructor() {
    this.buf = "";
    this.fence = false;
    this.sol = true;
    this.inl = null; // { type: "image"|"bold3"|"italic"|"ubold3"|"uitalic", acc: "" }
  }

  /**
   * 输入一段增量文本，返回尽可能多的已处理输出
   * @param {string} delta
   * @returns {string}
   */
  feed(delta) {
    this.buf += delta;
    return this._pump(false);
  }

  /**
   * 刷新剩余缓冲区，返回最终输出
   * @returns {string}
   */
  flush() {
    return this._pump(true);
  }

  // ======== 内部实现 ========

  _pump(eof) {
    let out = "";
    while (this.buf) {
      const prevLen = this.buf.length;
      const prevSol = this.sol;
      const prevFence = this.fence;
      const prevInl = this.inl;

      if (this.fence) out += this._pumpFence(eof);
      else if (this.inl) out += this._pumpInline(eof);
      else if (this.sol) out += this._pumpSOL(eof);
      else out += this._pumpBody(eof);

      // 如果状态没有变化，说明卡住了（需要更多数据），跳出
      if (
        this.buf.length === prevLen &&
        this.sol === prevSol &&
        this.fence === prevFence &&
        this.inl === prevInl
      ) {
        break;
      }
    }

    // EOF 时，闭合未完成的内联格式
    if (eof && this.inl) {
      const markers = {
        image: "![", bold3: "***", italic: "*", ubold3: "___", uitalic: "_", del: "~~"
      };
      out += (markers[this.inl.type] ?? "") + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  /** 代码块内：原样透传直到闭合 ``` */
  _pumpFence(eof) {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return "";
      if (this.buf.startsWith("```")) {
        const nl = this.buf.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = false;
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.fence = false;
          const remaining = this.buf;
          this.buf = "";
          return remaining;
        }
        return "";
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf("\n");
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = "";
    return chunk;
  }

  /** 行首：检测代码块、引用、标题、缩进、分割线 */
  _pumpSOL(eof) {
    const b = this.buf;

    // 换行
    if (b[0] === "\n") {
      this.buf = b.slice(1);
      return "\n";
    }

    // 代码块开始 ```
    if (b[0] === "`") {
      if (b.length < 3 && !eof) return "";
      if (b.startsWith("```")) {
        const nl = b.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = true;
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) { this.buf = ""; return b; }
        return "";
      }
      this.sol = false;
      return "";
    }

    // 引用 >  → 去掉标记符
    if (b[0] === ">") { this.sol = false; return ""; }

    // H1-H6 标题 ### → 去掉标记符，保留文字
    if (b[0] === "#") {
      let n = 0;
      while (n < b.length && b[n] === "#") n++;
      if (n === b.length && !eof) return "";
      if (n >= 1 && n <= 6 && n < b.length && b[n] === " ") {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return "";
      }
      this.sol = false;
      return "";
    }

    // 缩进 → 忽略
    if (b[0] === " " || b[0] === "\t") {
      if (b.search(/[^ \t]/) === -1 && !eof) return "";
      this.sol = false;
      return "";
    }

    // 分割线 --- / *** / ___ (3个及以上)
    if (b[0] === "-" || b[0] === "*" || b[0] === "_") {
      const ch = b[0];
      let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === " ")) j++;
      if (j === b.length && !eof) return "";
      if (j === b.length || b[j] === "\n") {
        let count = 0;
        for (let k = 0; k < j; k++) if (b[k] === ch) count++;
        if (count >= 3) {
          if (j < b.length) {
            const line = b.slice(0, j + 1);
            this.buf = b.slice(j + 1);
            this.sol = true;
            return line;
          }
          this.buf = "";
          return b;
        }
      }
      this.sol = false;
      return "";
    }

    this.sol = false;
    return "";
  }

  /** 正文：扫描内联格式触发点 */
  _pumpBody(eof) {
    let out = "";
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];

      if (c === "\n") {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }

      // 图片 ![...](url) → 整段删除
      if (c === "!" && i + 1 < this.buf.length && this.buf[i + 1] === "[") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: "image", acc: "" };
        return out;
      }

      // 删除线 ~~ → 去掉符号，保留内容
      if (c === "~") {
        if (i + 1 < this.buf.length && this.buf[i + 1] === "~") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 2);
          this.inl = { type: "del", acc: "" };
          return out;
        }
        i++;
        continue;
      }

      // *** ___ → 粗体+斜体
      if (c === "*") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "*" && this.buf[i + 2] === "*") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "bold3", acc: "" };
          return out;
        }
        // ** → 粗体（保留，不过滤）
        if (i + 1 < this.buf.length && this.buf[i + 1] === "*") { i += 2; continue; }
        // *text* → 斜体（中文去标记，英文保留）
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "italic", acc: "" };
          return out;
        }
        i++;
        continue;
      }

      if (c === "_") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "_" && this.buf[i + 2] === "_") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "ubold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === "_") { i += 2; continue; }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "uitalic", acc: "" };
          return out;
        }
        i++;
        continue;
      }

      i++;
    }

    // 缓冲区末尾的 ambiguous 字符暂不输出（等更多数据）
    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith("**")) hold = 2;
      else if (this.buf.endsWith("__")) hold = 2;
      else if (this.buf.endsWith("*")) hold = 1;
      else if (this.buf.endsWith("_")) hold = 1;
      else if (this.buf.endsWith("!")) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : "";
    return out;
  }

  /** 内联格式内：累积直到闭合标记 */
  _pumpInline(_eof) {
    if (!this.inl) return "";
    this.inl.acc += this.buf;
    this.buf = "";

    switch (this.inl.type) {
      case "bold3": {
        const idx = this.inl.acc.indexOf("***");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `***${content}***`;
        }
        return "";
      }
      case "ubold3": {
        const idx = this.inl.acc.indexOf("___");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `___${content}___`;
        }
        return "";
      }
      case "italic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "*" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "*") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "*") { j++; continue; }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `*${content}*`;
          }
        }
        return "";
      }
      case "uitalic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "_" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "_") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "_") { j++; continue; }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `_${content}_`;
          }
        }
        return "";
      }
      case "image": {
        const cb = this.inl.acc.indexOf("]");
        if (cb === -1) return "";
        if (cb + 1 >= this.inl.acc.length) return "";
        if (this.inl.acc[cb + 1] !== "(") {
          const r = "![" + this.inl.acc.slice(0, cb + 1);
          this.buf = this.inl.acc.slice(cb + 1);
          this.inl = null;
          return r;
        }
        const cp = this.inl.acc.indexOf(")", cb + 2);
        if (cp !== -1) {
          this.buf = this.inl.acc.slice(cp + 1);
          this.inl = null;
          return ""; // 整段删除
        }
        return "";
      }
      case "del": {
        const idx = this.inl.acc.indexOf("~~");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 2);
          this.inl = null;
          return content; // 去掉 ~~ 标记，保留内容
        }
        return "";
      }
    }
    return "";
  }

  /** 检查文本是否包含 CJK 字符（中文/日文/韩文） */
  static containsCJK(text) {
    return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
  }
}
