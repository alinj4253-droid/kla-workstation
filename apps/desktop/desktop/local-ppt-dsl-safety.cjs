const parser = require('@babel/parser');

const COMPONENTS = new Set([
  'Slide', 'Box', 'Text', 'Image', 'Chart', 'svg', 'g', 'defs', 'linearGradient',
  'radialGradient', 'stop', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan',
]);
const EXPRESSIONS = new Set([
  'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'Identifier',
  'ObjectExpression', 'ObjectProperty', 'ArrayExpression', 'UnaryExpression',
  'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'TemplateLiteral',
  'TemplateElement', 'ParenthesizedExpression',
]);

function assertSafeExpression(node, known) {
  if (!node || !EXPRESSIONS.has(node.type)) throw new Error(`PPT DSL 包含不允许的表达式：${node?.type || 'unknown'}`);
  if (node.type === 'Identifier' && !known.has(node.name)) throw new Error(`PPT DSL 引用了未定义常量：${node.name}`);
  if (node.type === 'ParenthesizedExpression') {
    assertSafeExpression(node.expression, known);
    return;
  }
  if (node.type === 'ObjectProperty') {
    if (node.computed || node.method || !['Identifier', 'StringLiteral'].includes(node.key?.type)) throw new Error('PPT DSL 对象属性只允许静态名称');
    assertSafeExpression(node.value, known);
    return;
  }
  if (node.type === 'ObjectExpression') {
    for (const property of node.properties) assertSafeExpression(property, known);
  } else if (node.type === 'ArrayExpression') {
    for (const value of node.elements) if (value) assertSafeExpression(value, known);
  } else if (node.type === 'UnaryExpression') {
    if (!['+', '-', '!'].includes(node.operator)) throw new Error('PPT DSL 不允许该一元运算');
    assertSafeExpression(node.argument, known);
  } else if (node.type === 'BinaryExpression') {
    if (!['+', '-', '*', '/', '%', '===', '!==', '<', '<=', '>', '>='].includes(node.operator)) throw new Error('PPT DSL 不允许该二元运算');
    assertSafeExpression(node.left, known); assertSafeExpression(node.right, known);
  } else if (node.type === 'LogicalExpression') {
    assertSafeExpression(node.left, known); assertSafeExpression(node.right, known);
  } else if (node.type === 'ConditionalExpression') {
    assertSafeExpression(node.test, known); assertSafeExpression(node.consequent, known); assertSafeExpression(node.alternate, known);
  } else if (node.type === 'TemplateLiteral') {
    for (const part of node.expressions) assertSafeExpression(part, known);
  }
}

function inspectJsx(node, known) {
  if (node.type === 'JSXText') return;
  if (node.type === 'JSXExpressionContainer') {
    if (node.expression.type !== 'JSXEmptyExpression') assertSafeExpression(node.expression, known);
    return;
  }
  if (node.type === 'JSXFragment') {
    for (const child of node.children) inspectJsx(child, known);
    return;
  }
  if (node.type !== 'JSXElement' || node.openingElement.name.type !== 'JSXIdentifier'
    || !COMPONENTS.has(node.openingElement.name.name)) throw new Error('PPT DSL 使用了不支持的组件');
  const tag = node.openingElement.name.name;
  for (const attr of node.openingElement.attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') throw new Error('PPT DSL 不允许展开属性或动态属性名');
    const name = attr.name.name;
    if (/^on[A-Z]/.test(name) || name === 'dangerouslySetInnerHTML') throw new Error('PPT DSL 不允许事件或原始 HTML');
    if (['src', 'href', 'xlinkHref'].includes(name)) {
      // All image bytes must have been copied through the approved local read gate.
      if (tag !== 'Image' || name !== 'src' || attr.value?.type !== 'StringLiteral'
        || !/^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp)$/i.test(attr.value.value)) {
        throw new Error('PPT 图片只能引用本次任务 assets/ 内已批准的图片');
      }
    } else if (attr.value?.type === 'JSXExpressionContainer') {
      assertSafeExpression(attr.value.expression, known);
    } else if (attr.value && attr.value.type !== 'StringLiteral') throw new Error('PPT DSL 属性值无效');
  }
  for (const child of node.children) inspectJsx(child, known);
}

function validateSource(source) {
  if (typeof source !== 'string' || source.length < 20 || source.length > 120_000) throw new Error('页面必须提供 20–120000 字符的 .slide DSL');
  const ast = parser.parse(source, { sourceType: 'script', plugins: ['jsx'], allowReturnOutsideFunction: false,
    createParenthesizedExpressions: true });
  const known = new Set(['undefined']);
  let root = false;
  for (const statement of ast.program.body) {
    if (statement.type === 'EmptyStatement') continue;
    if (root) throw new Error('PPT DSL 的 <Slide> 必须是最后一条语句');
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init) throw new Error('PPT DSL 常量必须直接赋值');
        assertSafeExpression(declaration.init, known);
        known.add(declaration.id.name);
      }
    } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'JSXElement'
      && statement.expression.openingElement.name.type === 'JSXIdentifier'
      && statement.expression.openingElement.name.name === 'Slide') {
      inspectJsx(statement.expression, known);
      root = true;
    } else throw new Error('PPT DSL 仅允许静态 const 常量与一个 <Slide> 页面');
  }
  if (!root) throw new Error('PPT DSL 缺少根 <Slide> 页面');
  return true;
}

module.exports = { validateSource };
