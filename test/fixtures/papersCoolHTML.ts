// Reduced snapshot of https://papers.cool/arxiv/2302.05019 captured 2026-08-14.
export const currentPapersCoolHTML = `<!doctype html>
<html>
  <head>
    <meta name="citation_title" content="A Comprehensive Survey on Automatic Knowledge Graph Construction">
  </head>
  <body>
    <div>Total: 1</div>
    <div class="papers">
      <div id="2302.05019" class="panel paper" keywords="knowledge,graph,survey,construction">
        <div>
          <a id="title-2302.05019" class="title-link notranslate" href="/arxiv/2302.05019">A Comprehensive Survey on Automatic Knowledge Graph Construction</a>
          <a id="pdf-2302.05019" class="title-pdf notranslate" data="https://arxiv.org/pdf/2302.05019">[PDF<sup id="pdf-stars-2302.05019">7</sup>]</a>
          <a class="title-kimi">[Kimi<sup id="kimi-stars-2302.05019">9</sup>]</a>
        </div>
        <p id="authors-2302.05019" class="metainfo authors notranslate"><strong>Authors</strong>: Lingfeng Zhong, Jia Wu</p>
        <p id="summary-2302.05019" class="summary notranslate">A survey of knowledge graph construction.</p>
        <p id="subjects-2302.05019" class="metainfo subjects"><strong>Subject</strong>: Information Retrieval</p>
        <p id="date-2302.05019" class="metainfo date"><strong>Publish</strong>: 2023-02-10</p>
      </div>
    </div>
  </body>
</html>`;

export const emptyPapersCoolHTML = `<!doctype html>
<html>
  <body>
    <div>Total: 0</div>
    <div class="papers"></div>
  </body>
</html>`;

export const semanticFallbackHTML = `<!doctype html>
<html>
  <body>
    <main data-paper-list>
      <article data-paper-id="fallback-paper" data-keywords="fallback,parser">
        <h2><a data-role="paper-title" href="/venue/fallback-paper">Fallback Paper</a></h2>
        <a data-role="paper-pdf" data-url="https://example.com/fallback.pdf">PDF</a>
        <p data-role="paper-authors">Authors: Ada Example</p>
        <p data-role="paper-summary">Fallback summary.</p>
        <p data-role="paper-subjects">Subject: Parser Testing</p>
        <p data-role="paper-date">Publish: 2026</p>
        <span data-role="kimi-stars">4</span>
        <span data-role="pdf-stars">5</span>
      </article>
    </main>
  </body>
</html>`;

// Reduced snapshot of https://papers.cool/venue/36974@AAAI captured 2026-08-14.
// The external publisher link intentionally precedes the papers.cool title link.
export const currentVenueHTML = `<!doctype html>
<html>
  <body>
    <div>Total: 1</div>
    <div class="papers">
      <div id="36974@AAAI" class="panel paper" keywords="proar,autoregressive,dynamics,molecular">
        <h2 class="title">
          <a href="https://ojs.aaai.org/index.php/AAAI/article/view/36974"><span class="index">#1</span></a>
          <a id="title-36974@AAAI" class="title-link notranslate" href="/venue/36974@AAAI">ProAR: Probabilistic Autoregressive Modeling for Molecular Dynamics</a>
          <a id="pdf-36974@AAAI" class="title-pdf notranslate" data="https://ojs.aaai.org/index.php/AAAI/article/view/36974/40936">[PDF]</a>
        </h2>
        <p id="authors-36974@AAAI" class="metainfo authors notranslate"><strong>Authors</strong>: Kaiwen Cheng, Yutian Liu</p>
        <p id="summary-36974@AAAI" class="summary notranslate">A probabilistic autoregressive framework for molecular dynamics.</p>
        <p id="subjects-36974@AAAI" class="metainfo subjects"><strong>Subject</strong>: AAAI.2026 - Application Domains</p>
      </div>
    </div>
  </body>
</html>`;
