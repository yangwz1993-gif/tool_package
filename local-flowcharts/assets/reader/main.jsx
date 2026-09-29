import React, {useCallback, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LikeC4Model} from '@likec4/core/model';
import {LikeC4ModelProvider, ReactLikeC4} from 'likec4/react';
import data from './model.json';
import options from './reader-options.json';
import diagramCss from './diagram.css?inline';
import {readingViewport, orderedSections} from './viewport.mjs';
import './reader.css';

const model = LikeC4Model.create(data);
const view = data.views.index;
const sections = orderedSections(view);
const steps = view.nodes.filter(n => n.kind !== '@group');
const fontFamily = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const mantineTheme = {fontFamily, headings: {fontFamily}};
const interaction = {panOnScroll:true, zoomOnScroll:false, zoomActivationKeyCode:['Control','Meta']};

function Reader() {
  const canvas = useRef(null);
  const api = useRef(null);
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState(sections[0]?.id ?? 'reading');
  const showSection = useCallback((section, duration = 240) => {
    if (!api.current || !canvas.current) return;
    const anchor = section ?? view.bounds;
    const viewport = readingViewport(view.bounds, canvas.current.clientWidth, options.scale, anchor, view.autoLayout?.direction);
    api.current.diagram.send({type:'xyflow.setViewport', viewport, duration});
    setCurrent(section?.id ?? 'reading');
  }, []);
  const initialize = useCallback(instance => {
    api.current = instance;
    setReady(true);
    // Initialization is emitted after LikeC4 installs the layout and viewport.
    showSection(sections[0], 0);
  }, [showSection]);
  const openNode = useCallback(node => {
    if (node.kind !== '@group') api.current?.diagram.openElementDetails(node.id, node.id);
  }, []);
  const overview = () => {
    api.current?.diagram.fitDiagram(240);
    setCurrent('overview');
  };
  return <div className="reader">
    <header className="reader-header">
      <div>
        <p className="eyebrow">完整流程 · 分区阅读</p>
        <h1>{view.title || options.title}</h1>
      </div>
      <div className="reader-actions" aria-label="画布操作">
        <button disabled={!ready} onClick={() => showSection(sections[0])}>从头阅读</button>
        <button disabled={!ready} aria-pressed={current === 'overview'} onClick={overview}>全图总览</button>
        <span className="action-divider" />
        <button className="zoom-button" disabled={!ready} aria-label="缩小" onClick={() => api.current?.xyflow.zoomOut()}>−</button>
        <button className="zoom-button" disabled={!ready} aria-label="放大" onClick={() => api.current?.xyflow.zoomIn()}>＋</button>
      </div>
    </header>
    <div className="reader-body">
      <aside className="reader-sidebar" aria-label="流程阶段">
        <p className="sidebar-caption">阶段导航</p>
        <nav>{sections.map(section => <button key={section.id} disabled={!ready}
          aria-pressed={current === section.id} onClick={() => showSection(section)}>
          <span>{section.title}</span><small>{section.children.length} 个步骤</small>
        </button>)}</nav>
        <div className="reader-legend">
          <p><i className="decision-dot" />判断</p>
          <p><i className="retry-line" />返工回路</p>
          <p><i className="done-dot" />输入 / 验收 / 交付</p>
        </div>
        <p className="sidebar-note">所有步骤都在同一张图中。点击阶段可快速定位。</p>
      </aside>
      <main className="reader-canvas" ref={canvas} aria-label="完整流程画布">
        <LikeC4ModelProvider likec4model={model}>
          <ReactLikeC4 viewId="index" colorScheme="light" injectFontCss={false}
            keepAspectRatio={false} initialZoom={options.scale} fitView={true}
            fitViewPadding={32} pannable={true} zoomable={true} controls={false}
            minZoom={0.15} maxZoom={2.5} background="solid" mantineTheme={mantineTheme}
            enableElementDetails={true} enableRelationshipDetails={true}
            enableRelationshipBrowser={true} enableElementTags={false}
            onInitialized={initialize} onNodeClick={openNode} reactFlowProps={interaction}>
            <style>{diagramCss}</style>
          </ReactLikeC4>
        </LikeC4ModelProvider>
      </main>
    </div>
    <footer className="reader-footer">
      <span>{sections.length} 个阶段 · {steps.length} 个步骤 · {view.edges.length} 条关系</span>
      <span>滚动或拖动浏览 · Ctrl / ⌘ + 滚轮缩放 · 点击节点查看详情</span>
    </footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<Reader />);
