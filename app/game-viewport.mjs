// Fixed game canvas geometry. Visual offsets are relevant only while editing or
// zooming; WebKit may retain a stale keyboard/rotation offset at normal scale.
export function gameViewport({width,height,visual,editing=false}={}) {
  const positive=(value,fallback)=>Number.isFinite(value) && value>0?value:fallback;
  const w=positive(width,1),h=positive(height,1),scale=positive(visual?.scale,1);
  const zoomed=Math.abs(scale-1)>.025;
  const staleWidth=!zoomed && Math.abs(positive(visual?.width,w)-w)>Math.max(4,w*.1);
  const vw=staleWidth?w:positive(visual?.width,w),vh=staleWidth?h:positive(visual?.height,h);
  const offset=value=>Number.isFinite(value)?Math.max(0,value):0;
  return {width:vw,height:vh,top:editing || zoomed?offset(visual?.offsetTop):0,
    left:editing || zoomed?offset(visual?.offsetLeft):0,resetScroll:!editing && !zoomed};
}
