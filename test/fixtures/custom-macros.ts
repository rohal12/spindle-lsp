Story.defineMacro({
  name: 'agebox',
  storeVar: true,
  description: 'Age selection box',
  render(_props, ctx) { return null; },
});

Story.defineMacro({
  name: 'chargenOption',
  merged: true,
  block: true,
  subMacros: ['option'],
  render(props, ctx) { return null; },
});
