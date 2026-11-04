"use strict";
window.CallLogAnalytics = {
  mount(root, {json, download, isActive, onError}) {
    root.innerHTML = `
    <div class="heading"><div><h1 id="analytics-title" tabindex="-1">Analítica y reportes</h1><p>Explora la actividad de tus equipos y líneas.</p></div></div>
    <div class="views-head row"><span class="hint">Vistas guardadas</span><div class="row"><button id="ca-view-new" type="button" aria-expanded="false" aria-controls="ca-view-editor">Guardar vista</button><button id="ca-view-manage" type="button" aria-expanded="false" aria-controls="ca-view-manager">Administrar vistas</button></div></div>
    <div id="ca-views" class="questions" aria-label="Vistas guardadas"></div>
    <section id="ca-view-editor" class="view-panel" hidden aria-label="Guardar vista personalizada"><div class="row"><label class="field view-name">Nombre de la vista<input id="ca-view-name" type="text" maxlength="50" autocomplete="off" placeholder="Ej.: Ventas · llamadas semanales"></label><button id="ca-view-save" class="primary" type="button">Guardar</button><button id="ca-view-cancel" type="button">Cancelar</button></div><p class="hint">Guarda los filtros aplicados, la agrupación y la configuración del gráfico.</p><p id="ca-view-error" class="hint error" role="alert"></p></section>
    <section id="ca-view-manager" class="view-panel" hidden aria-labelledby="ca-view-manager-title"><h2 id="ca-view-manager-title">Administrar vistas</h2><p class="hint">Eliminar una vista conserva todos los registros.</p><ul id="ca-view-list" class="view-list"></ul><div class="row"><button id="ca-views-restore" type="button">Restaurar predeterminadas</button><button id="ca-view-undo" type="button" hidden>Deshacer eliminación</button><button id="ca-view-manager-close" type="button">Cerrar</button></div></section><p id="ca-view-message" class="hint" role="status" aria-live="polite"></p>
    <div class="period-row"><label class="field">Periodo<select id="ca-period"><option value="7d">Últimos 7 días · parcial</option><option value="30d">Últimos 30 días · parcial</option><option value="month">Mes actual · parcial</option><option value="6m" selected>Últimos 6 meses completos</option><option value="custom">Personalizado</option></select></label><span id="ca-range" class="range-label"></span></div>
    <details id="ca-filters" class="filters"><summary>Filtros <span id="ca-filter-count" class="filter-count">Sin filtros adicionales</span></summary><form id="ca-filter-form"><div class="filter-grid"><label class="field">Equipo<select id="ca-device"><option value="">Todos los equipos</option></select></label><label class="field wide">SIM / línea<select id="ca-line"></select></label><label class="field">Tipo<select id="ca-type"><option value="">Todos los tipos</option><option value="1">Entrante</option><option value="2">Saliente</option><option value="3">Perdida</option><option value="4">Buzón de voz</option><option value="5">Rechazada</option><option value="6">Bloqueada</option><option value="7">Contestada en otro equipo</option></select></label><label class="field">Desde<input id="ca-from" type="date" min="1969-12-31" max="2100-01-01"></label><label class="field">Hasta<input id="ca-to" type="date" min="1969-12-31" max="2100-01-01"></label></div><div class="row"><button id="ca-apply" class="primary" type="button">Aplicar filtros</button><button id="ca-reset" type="button">Limpiar filtros</button><span id="ca-draft" class="hint" role="status"></span></div><p id="ca-filter-error" class="hint error" role="alert"></p></form></details>
    <dl class="stats" aria-label="Resumen de los filtros aplicados"><div><dt>Llamadas registradas</dt><dd id="ca-kpi-count">—</dd><small id="ca-delta-count"></small></div><div><dt>Duración registrada</dt><dd id="ca-kpi-minutes">—</dd><small id="ca-delta-minutes"></small></div><div><dt>Duración media por registro</dt><dd id="ca-kpi-average">—</dd><small id="ca-delta-average"></small></div></dl>
    <section class="chart-section" aria-labelledby="ca-chart-title"><div class="chart-head"><h2 id="ca-chart-title">Evolución de las llamadas</h2><span id="ca-consolidated" class="hint"></span></div>
      <div class="chart-tools"><label class="field">Ver<select id="ca-metric"><option value="count">Cantidad de llamadas</option><option value="minutes">Minutos registrados</option><option value="average">Duración media · segundos</option><option value="missed">Proporción de perdidas</option></select></label><label class="field">Agrupar<select id="ca-group"><option value="day">Día</option><option value="week">Semana</option><option value="month" selected>Mes</option><option value="device">Equipo</option><option value="line">SIM / línea</option><option value="type">Tipo</option></select></label><label class="field">Desglosar<select id="ca-breakdown"><option value="none">Sin desglose</option><option value="device" selected>Equipo</option><option value="line">SIM / línea</option><option value="type">Tipo</option></select></label><label class="field">Gráfico<select id="ca-chart"><option value="bars">Barras agrupadas</option><option value="stacked">Barras apiladas</option><option value="line">Líneas</option><option value="area">Área</option><option value="donut">Dona</option></select></label></div>
      <div class="row"><label class="check"><input id="ca-compare" type="checkbox">Comparar periodo anterior</label><label class="check"><input id="ca-share" type="checkbox">Mostrar participación (%)</label></div><p id="ca-compatibility" class="hint"></p><p id="ca-definition" class="hint"></p><p id="ca-comparison" class="hint"></p>
      <div id="ca-legend" class="legend" aria-label="Series visibles"></div><p class="hint">Ocultar una serie solo cambia el gráfico; no filtra indicadores, tablas ni exportaciones.</p>
      <div id="ca-plot" class="plot"><svg id="ca-svg" class="chart-svg" role="img" aria-labelledby="ca-svg-title ca-svg-desc"></svg><div id="ca-empty" class="empty" hidden></div><div id="ca-tooltip" class="plot-tip" role="tooltip" hidden></div></div><p id="ca-chart-caption" class="hint"></p>
    </section>
    <div class="section-head"><h2>Resumen por grupo</h2><div class="row export-tools"><label class="field">Formato<select id="ca-summary-format" aria-label="Formato del resumen"><option value="csv">CSV (.csv)</option><option value="xlsx">Excel (.xlsx)</option></select></label><button id="ca-export-summary" type="button">Descargar resumen</button></div></div><div class="table-wrap"><table><thead><tr><th id="ca-group-heading">Mes</th><th>Serie</th><th class="num">Llamadas</th><th id="ca-value-heading" class="num">Cantidad</th><th id="ca-share-heading" class="num">% del total</th><th id="ca-previous-heading" class="num" hidden>Anterior</th></tr></thead><tbody id="ca-aggregate-rows"></tbody></table></div><div class="pager"><span id="ca-aggregate-page" class="hint"></span><div class="row"><button id="ca-aggregate-prev">Anterior</button><button id="ca-aggregate-next">Siguiente</button></div></div>
    <details id="ca-records" class="records"><summary>Registros de la vista <span id="ca-record-count" class="filter-count"></span></summary><div class="selection"><span id="ca-selection-label">Sin selección del gráfico</span><button id="ca-clear-selection" hidden>Quitar selección</button></div><div class="row export-tools"><label class="field">Formato<select id="ca-records-format" aria-label="Formato del detalle"><option value="csv">CSV (.csv)</option><option value="xlsx">Excel (.xlsx)</option></select></label><button id="ca-export-records" type="button">Descargar detalle</button><span class="hint">Incluye todas las páginas de los filtros y la selección actual.</span></div><div class="table-wrap"><table><thead><tr><th>Equipo</th><th>SIM / línea</th><th>Número</th><th>Tipo</th><th>Inicio · UTC−03</th><th class="num">Duración</th></tr></thead><tbody id="ca-record-rows"></tbody></table></div><div class="pager"><label class="field">Registros por página<select id="ca-size"><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option></select></label><span id="ca-record-page" class="hint"></span><div class="row"><button id="ca-record-prev">Anterior</button><button id="ca-record-next">Siguiente</button></div></div></details>
    <p id="ca-coverage" class="coverage"></p><p id="ca-feedback" role="status" aria-live="polite"></p>
    `;
    const el = id => root.querySelector('#ca-' + id);
    const DAY = 86400000, OFFSET = 3 * 3600000;
    const names = {1:'Entrante',2:'Saliente',3:'Perdida',4:'Buzón de voz',5:'Rechazada',6:'Bloqueada',7:'Contestada en otro equipo'};
    const groupNames = {day:'Día',week:'Semana',month:'Mes',device:'Equipo',line:'SIM / línea',type:'Tipo'};
    const metrics = {count:{name:'Cantidad de llamadas',unit:'llamadas',additive:true},minutes:{name:'Minutos registrados',unit:'min',additive:true},average:{name:'Duración media',unit:'s por registro',additive:false},missed:{name:'Proporción de perdidas',unit:'%',additive:false}};
    const fields = ['preset','from','to','device','line','type','metric','group','breakdown','chart','compare','share'];
    const defaultIds = ['trend','devices','lines','missed'];
    const ms = value => Date.parse(value + 'T00:00:00Z');
    const iso = value => new Date(value).toISOString().slice(0,10);
    const localDate = value => iso(value - OFFSET);
    const dateTime = value => value == null ? 'Sin dato' : new Date(value - OFFSET).toISOString().slice(0,16).replace('T',' ');
    const fullDate = value => new Date(ms(value)).toLocaleDateString('es-PY',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
    const nf = new Intl.NumberFormat('es-PY',{maximumFractionDigits:1});
    const number = value => value == null ? '—' : nf.format(value);
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(ms(value)) && iso(ms(value)) === value;
    const viewConfig = value => Object.fromEntries(fields.map(key => [key,value[key]]));
    const blankStat = () => ({count:0,seconds:0,missed:0});
    const addStats = (total,item) => ({count:total.count+item.count,seconds:total.seconds+item.seconds,missed:total.missed+item.missed});
    const lineKey = line => JSON.stringify([line.device_id,line.phone_account_component_name,line.phone_account_id]);
    const lineName = line => line.line_label && line.phone_account_id ? line.line_label+' ('+line.phone_account_id+')' : line.line_label || line.phone_account_id || 'Sin SIM identificada';
    const temporal = () => ['day','week','month'].includes(state.group);
    let today = localDate(Date.now()), catalog = {devices:[],lines:[]};
    let state = defaults(), model = null, dirty = false, generation = 0, serial = 0;
    let revision = null, library = {hiddenDefaults:[],views:[]}, removedView = null, viewPromise = null, viewBusy = false;
    let previousGeometry = new Map(), animationFrame = 0;
    const design = {plotHeight:340};
    const exportFormats = {summary:'csv',records:'csv'};
    const exportPending = {summary:false,records:false};
    const active = run => run === generation && isActive();
    function range(preset) {
      if (preset === '6m') { const end = new Date(ms(today)); end.setUTCDate(1); const start = new Date(end); start.setUTCMonth(start.getUTCMonth()-6); return {from:iso(start),to:iso(+end-DAY)}; }
      return {from:preset==='month'?today.slice(0,7)+'-01':iso(ms(today)-(preset==='7d'?6:29)*DAY),to:today};
    }
    function defaults() { return {preset:'6m',...range('6m'),device:'',line:'',type:'',metric:'count',group:'month',breakdown:'device',chart:'bars',compare:false,share:false,guide:'trend',hiddenSeries:[],hiddenGroups:[],selection:null,aggregatePage:0,recordPage:0,size:10}; }
    function defaultViews() {
      const base=viewConfig(defaults());
      return [{id:'trend',name:'¿Cómo evolucionan las llamadas?',config:base},{id:'devices',name:'¿Qué equipos concentran actividad?',config:{...base,group:'device',breakdown:'none'}},{id:'lines',name:'¿Qué líneas utilizamos?',config:{...base,group:'line',breakdown:'none'}},{id:'missed',name:'¿Cuántas llamadas perdidas?',config:{...base,type:'3'}}];
    }
    const allViews = () => [...defaultViews().filter(view=>!library.hiddenDefaults.includes(view.id)),...library.views];
    const seriesColors = new Map();
    function color(key,dimension) {
      if (key==='unknown') return 'var(--ca-unknown)';
      if (dimension==='none') return 'var(--ca-s1)';
      if(!seriesColors.has(dimension))seriesColors.set(dimension,new Map());
      const assigned=seriesColors.get(dimension);
      if(!assigned.has(key))assigned.set(key,assigned.size%6+1);
      return 'var(--ca-s'+assigned.get(key)+')';
    }
    function value(stat,metric=state.metric) {
      if(metric==='count')return stat.count;
      if(metric==='minutes')return stat.seconds/60;
      if(!stat.count)return null;
      return metric==='average'?stat.seconds/stat.count:100*stat.missed/stat.count;
    }
    function groupLabel(key,label,dimension) {
      if(dimension==='month' && /^\d{4}-\d{2}$/.test(key))return new Date(ms(key+'-01')).toLocaleDateString('es-PY',{timeZone:'UTC',month:'short',year:'numeric'});
      if(['day','week'].includes(dimension) && validDate(key))return new Date(ms(key)).toLocaleDateString('es-PY',{timeZone:'UTC',day:'numeric',month:'short'});
      return label;
    }
    function normalizeConfig(input) {
      const result={...defaults(),...Object.fromEntries(fields.map(key=>[key,input[key]]))};
      if(result.preset!=='custom')Object.assign(result,range(result.preset));
      if(result.line && result.line!=='unknown')result.device=JSON.parse(result.line)[0];
      return result;
    }
    function compatible() {
      const additive=metrics[state.metric].additive,time=temporal();
      for(const option of el('breakdown').options)option.disabled=option.value===state.group;
      if(state.breakdown===state.group)state.breakdown='none';
      const disabled={bars:false,stacked:!additive,line:!time,area:!time||!additive,donut:!additive||time||state.breakdown!=='none'};
      for(const option of el('chart').options)option.disabled=disabled[option.value];
      if(disabled[state.chart])state.chart='bars';
      if(!additive)state.share=false;
      el('share').disabled=!additive;
      el('compatibility').textContent=!additive?'La media y las proporciones se recalculan por grupo. No se suman: participación, apiladas, área y dona no están disponibles.':time?'Líneas y área muestran evolución temporal. La dona está disponible por equipo, SIM o tipo, sin desglose.':'Líneas y área requieren día, semana o mes. La dona requiere quitar el desglose.';
      for(const id of ['metric','group','breakdown','chart'])el(id).value=state[id];
      el('compare').checked=state.compare;el('share').checked=state.share;
    }
    function renderCatalog() {
      const selected=el('device').value;
      el('device').replaceChildren(new Option('Todos los equipos',''));
      for(const device of catalog.devices)el('device').add(new Option(device.name,device.id));
      if(selected && !catalog.devices.some(device=>device.id===selected))el('device').add(new Option('Equipo guardado ('+selected+')',selected));
      el('device').value=selected;lineOptions();
    }
    function lineOptions(selected=el('line').value) {
      const device=el('device').value;el('line').replaceChildren(new Option('Todas las líneas',''));
      for(const line of catalog.lines.filter(line=>!device || line.device_id===device)){const option=new Option(lineName(line)+(device?'':' · '+line.device_name),lineKey(line));option.title=line.phone_account_component_name;el('line').add(option);}
      el('line').add(new Option('Sin SIM identificada','unknown'));
      if(selected && ![...el('line').options].some(option=>option.value===selected))el('line').add(new Option('Cuenta guardada ('+JSON.parse(selected)[2]+')',selected));
      el('line').value=selected;
    }
    function syncDraft() {
      el('device').value=state.device;
      if(state.device && ![...el('device').options].some(option=>option.value===state.device)){el('device').add(new Option('Equipo guardado ('+state.device+')',state.device));el('device').value=state.device;}
      lineOptions(state.line);el('type').value=state.type;el('from').value=state.from;el('to').value=state.to;el('period').value=state.preset;
      dirty=false;el('draft').textContent='';el('filter-error').textContent='';
    }
    function reportState() { return {...viewConfig(state),selection:state.selection,offset:state.recordPage*state.size,limit:state.size}; }
    function endpoint(path,snapshot=reportState()) { return path+'?state='+encodeURIComponent(JSON.stringify(snapshot)); }
    function acceptReport(data) {
      const cells=new Map(data.rows.map(row=>[JSON.stringify([row.group,row.series]),row]));
      return {...data,groups:data.groups.map(group=>({...group,label:groupLabel(group.key,group.label,state.group)})),series:data.series.map(serie=>({...serie,color:color(serie.key,state.breakdown)})),rows:data.rows.map(row=>({...row,label:groupLabel(row.group,row.label,state.group)})),cell:(group,serie,old=false)=>{const row=cells.get(JSON.stringify([group,serie]));return row?(old?row.before:row.stat):blankStat();}};
    }
    function feedback(text='',error=false){el('feedback').textContent=text;el('feedback').classList.toggle('error',error);}
    function selectionLabel() {if(!state.selection)return 'Sin selección del gráfico';const group=model?.groups.find(group=>group.key===state.selection.group),serie=model?.series.find(serie=>serie.key===state.selection.series);return (group?.label||'Grupo seleccionado')+(serie && state.breakdown!=='none'?' · '+serie.label:'');}
    function delta(metric) {
      if(!state.compare)return '';
      if(!model.coveredPrevious)return 'Sin base comparativa recibida';
      const now=value(model.total,metric),before=value(model.oldTotal,metric);
      if(now==null)return 'Sin datos actuales';
      if(before==null)return 'Sin base comparativa recibida';
      if(metric==='average')return (now-before>=0?'+':'')+number(now-before)+' s vs. periodo anterior';
      if(before===0)return 'Sin base comparativa recibida';
      return (now-before>=0?'+':'')+number((now-before)/before*100)+'% vs. periodo anterior';
    }
    function cell(row,text,numeric=false){const td=document.createElement('td');td.textContent=text;if(numeric)td.className='num';row.append(td);return td;}
    function emptyRow(target,text,columns){const row=document.createElement('tr');cell(row,text).colSpan=columns;el(target).replaceChildren(row);}
    function renderAggregates() {
      const pages=Math.max(1,Math.ceil(model.rows.length/10));state.aggregatePage=Math.min(state.aggregatePage,pages-1);const start=state.aggregatePage*10;
      el('aggregate-rows').replaceChildren();el('group-heading').textContent=groupNames[state.group];el('value-heading').textContent=metrics[state.metric].name+(state.metric==='minutes'?' · min':state.metric==='average'?' · s':'');
      el('share-heading').hidden=!metrics[state.metric].additive;el('previous-heading').hidden=!state.compare;
      for(const item of model.rows.slice(start,start+10)){const row=document.createElement('tr'),td=cell(row,''),button=document.createElement('button');button.type='button';button.textContent=item.label;button.setAttribute('aria-label','Ver registros de '+item.label+' · '+item.seriesLabel);button.onclick=()=>pick(item.group,item.series);td.append(button);cell(row,item.seriesLabel);cell(row,number(item.stat.count),true);cell(row,number(item.value),true);const share=cell(row,item.share==null?'—':number(item.share)+'%',true);share.hidden=!metrics[state.metric].additive;if(state.compare)cell(row,model.coveredPrevious?number(value(item.before)):'Sin datos previos',true);el('aggregate-rows').append(row);}
      if(!model.rows.length)emptyRow('aggregate-rows','Sin grupos para los filtros aplicados.',state.compare?6:5);
      el('aggregate-page').textContent=model.rows.length?(start+1)+'–'+Math.min(start+10,model.rows.length)+' de '+number(model.rows.length)+' filas agregadas':'0 filas';el('aggregate-prev').disabled=state.aggregatePage===0;el('aggregate-next').disabled=state.aggregatePage>=pages-1;
    }
    function renderRecords() {
      const data=model.detail;el('record-rows').replaceChildren();
      for(const call of data.calls){const row=document.createElement('tr');cell(row,call.device_name);const line=cell(row,lineName(call));if(call.phone_account_component_name)line.title=call.phone_account_component_name;cell(row,call.presentation===1 && call.number?call.number:'Privado o desconocido');cell(row,names[call.type]||'Otra');cell(row,dateTime(call.started_at));cell(row,Math.floor(call.duration_seconds/60)+'m '+call.duration_seconds%60+'s',true);el('record-rows').append(row);}
      if(!data.calls.length)emptyRow('record-rows','Sin registros para los filtros y la selección actual.',6);
      const start=state.recordPage*state.size;el('record-count').textContent=number(data.total)+' registros';el('selection-label').textContent=selectionLabel();el('clear-selection').hidden=!state.selection;
      el('record-page').textContent=data.total?(start+1)+'–'+(start+data.calls.length)+' de '+number(data.total):'0 registros';el('record-prev').disabled=state.recordPage===0;el('record-next').disabled=!data.has_more;el('size').value=String(state.size);
    }
    function legend(){
      const entries=state.chart==='donut'?model.groups.map(group=>({key:group.key,label:group.label,color:color(group.key,state.group)})):model.series;
      const hidden=state.chart==='donut'?state.hiddenGroups:state.hiddenSeries;el('legend').replaceChildren();
      for(const entry of entries){const button=document.createElement('button'),swatch=document.createElement('span'),text=document.createElement('span');button.type='button';button.setAttribute('aria-pressed',String(!hidden.includes(entry.key)));button.setAttribute('aria-label',(!hidden.includes(entry.key)?'Ocultar ':'Mostrar ')+entry.label);swatch.className='swatch';swatch.style.background=entry.color;text.textContent=entry.label;button.append(swatch,text);button.onclick=()=>{const index=hidden.indexOf(entry.key);if(index<0)hidden.push(entry.key);else hidden.splice(index,1);legend();drawChart();};el('legend').append(button);}
      if(state.compare && model.coveredPrevious && state.chart!=='donut'){const label=document.createElement('span'),swatch=document.createElement('span');label.className='row hint';swatch.className='swatch previous-swatch';label.append(swatch,document.createTextNode(state.breakdown==='none'?'Periodo anterior · consolidado':'Mismo color · anterior con trazo discontinuo'));el('legend').append(label);}
    }
    function render() {
      if(!model)return;
      el('range').textContent=fullDate(state.from)+' – '+fullDate(state.to)+(state.to>=today?' · periodo en curso':'');
      const count=Number(!!state.device)+Number(!!state.line)+Number(!!state.type)+Number(state.preset==='custom');el('filter-count').textContent=count?count+' aplicados':'Sin filtros adicionales';
      el('kpi-count').textContent=number(model.total.count);el('kpi-minutes').textContent=number(model.total.seconds/60)+' min';el('kpi-average').textContent=number(value(model.total,'average'))+(model.total.count?' s':'');
      el('delta-count').textContent=delta('count');el('delta-minutes').textContent=delta('minutes');el('delta-average').textContent=delta('average');
      el('chart-title').textContent=metrics[state.metric].name+' por '+groupNames[state.group].toLowerCase();el('consolidated').textContent='Consolidado: '+number(model.totalValue)+' '+metrics[state.metric].unit;
      el('definition').textContent=state.metric==='average'?'Media = suma de duración / número de registros recibidos; incluye duraciones cero y se recalcula en cada grupo.':state.metric==='missed'?'Perdidas = tipo 3 / todos los registros recibidos del grupo con los filtros aplicados. No mide atención ni llamadas contestadas.':state.share?'Participación sobre '+number(model.totalValue)+' '+metrics[state.metric].unit+' del periodo filtrado. Ocultar series no cambia ese denominador.':state.metric==='minutes'?'Duración registrada: suma de segundos / 60. No equivale necesariamente a tiempo de conversación.':'Cantidad: registros recibidos únicos por equipo e identificador de llamada.';
      el('comparison').textContent=state.compare?(fullDate(model.previous.from)+' – '+fullDate(model.previous.to)+' · '+model.previous.label+(model.coveredPrevious?(state.chart==='donut'?' · comparación en indicadores y tabla':model.previous.kind==='months'?' · alineado por mes calendario':' · alineado al intervalo actual'):' · no se recibieron registros comparables')):'';
      el('chart-caption').textContent=state.chart==='donut'?'Selecciona un segmento o una fila del resumen para ver sus registros.':state.group==='week'?'Las semanas comienzan el lunes. Selecciona una barra, punto o fila para ver sus registros.':'Selecciona una barra, punto o fila del resumen para ver sus registros.';
      const coverage=model.coverage;el('coverage').textContent='Solo se analizan llamadas recibidas por este servidor; la sincronización pendiente puede dejar periodos incompletos. '+(coverage.first==null?'Aún no hay llamadas recibidas.':'Historial recibido: '+dateTime(coverage.first)+' – '+dateTime(coverage.last)+'.')+' Consulta: '+dateTime(model.as_of)+' · UTC−03:00 fijo. La comparación no confirma que el historial esté completo.';
      renderViews();renderAggregates();renderRecords();legend();drawChart();
      for(const kind of ['summary','records'])el('export-'+kind).disabled=exportPending[kind];
    }
  function svgNode(name,attributes={},parent=el('svg')) {const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));parent.append(node);return node;}
  function svgText(text,x,y,attributes={}){const node=svgNode('text',{x,y,...attributes});node.textContent=text;return node;}
  function tip(title,rows,x,y){const node=el('tooltip');node.replaceChildren();const heading=document.createElement('strong');heading.textContent=title;node.append(heading);for(const row of rows){const line=document.createElement('div'),name=document.createElement('span'),value=document.createElement('span');name.textContent=row[0];value.textContent=row[1];line.append(name,value);node.append(line);}node.hidden=false;const width=el('plot').clientWidth;node.style.left=Math.max(4,Math.min(x+12,width-node.offsetWidth-4))+'px';node.style.top=Math.max(4,y-node.offsetHeight-10)+'px';}
  function chartValue(stat,prior=false){const result=value(stat);if(result==null)return null;if(!state.share)return result;const base=prior?value(model.oldTotal):model.denominator;return base>0?100*result/base:null;}
  function prettyValue(value){return number(value)+' '+(state.share?'%':metrics[state.metric].unit);}
  function drawChart(){
    if(!model)return;
    cancelAnimationFrame(animationFrame);const svg=el('svg');svg.onpointermove=null;svg.onpointerleave=null;svg.replaceChildren();el('tooltip').hidden=true;
    const width=Math.max(240,Math.floor(el('plot').getBoundingClientRect().width||720)),height=width<420?Math.min(310,design.plotHeight):design.plotHeight;
    svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('height',String(height));
    const title=svgNode('title',{id:'ca-svg-title'});title.textContent=el('chart-title').textContent;
    const desc=svgNode('desc',{id:'ca-svg-desc'});desc.textContent=number(model.total.count)+' registros filtrados. '+model.groups.length+' grupos. Valores exactos y botones de detalle disponibles en la tabla Resumen por grupo.';
    const visible=model.series.filter(serie=>!state.hiddenSeries.includes(serie.key));
    const hasMarks=state.chart==='donut'?model.groups.some(group=>!state.hiddenGroups.includes(group.key)):visible.length>0;
    const empty=!model.total.count || !hasMarks || !model.groups.length || state.share && !(model.denominator>0);
    el('empty').hidden=!empty;svg.toggleAttribute('hidden',empty);
    if(empty){el('empty').textContent=!model.total.count?'Sin registros recibidos para los filtros aplicados. Ajusta los filtros o el periodo.':!hasMarks?'Todas las series están ocultas. Activa una en la leyenda para volver a ver el gráfico.':'No hay duración registrada para calcular la participación. Desactiva Mostrar participación para ver los valores.';previousGeometry=new Map();return;}
    const nextGeometry=new Map(),transitions=[],reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    function rectMark(key,attributes){const node=svgNode('rect',attributes),before=previousGeometry.get(key);nextGeometry.set(key,{kind:'rect',...attributes});if(before?.kind==='rect' && !reduce && ['x','y','width','height'].some(name=>before[name]!==attributes[name]))transitions.push(t=>{for(const name of ['x','y','width','height'])node.setAttribute(name,String(before[name]+(attributes[name]-before[name])*t));});return node;}
    if(state.chart==='donut'){
      const cx=width/2,cy=height/2,radius=Math.max(52,Math.min(width*.29,height*.36)),inside=radius*.63,total=value(model.total)||0;
      svgNode('circle',{cx,cy,r:(radius+inside)/2,fill:'none',stroke:'var(--ca-line)','stroke-width':radius-inside});
      let angle=-Math.PI/2;
      for(const group of model.groups){const item=model.series.reduce((result,serie)=>addStats(result,model.cell(group.key,serie.key)),blankStat()),amount=value(item)||0,arc=total>0?amount/total*Math.PI*2:0,start=angle;angle+=arc;if(!amount || state.hiddenGroups.includes(group.key))continue;
        const point=(r,a)=>[cx+r*Math.cos(a),cy+r*Math.sin(a)],a=point(radius,start),b=point(radius,angle),c=point(inside,angle),d=point(inside,start),large=arc>Math.PI?1:0;
        let path;
        if(arc>=Math.PI*2-.001){path='M '+(cx+radius)+' '+cy+' A '+radius+' '+radius+' 0 1 0 '+(cx-radius)+' '+cy+' A '+radius+' '+radius+' 0 1 0 '+(cx+radius)+' '+cy+' M '+(cx+inside)+' '+cy+' A '+inside+' '+inside+' 0 1 1 '+(cx-inside)+' '+cy+' A '+inside+' '+inside+' 0 1 1 '+(cx+inside)+' '+cy;}
        else path='M '+a+' A '+radius+' '+radius+' 0 '+large+' 1 '+b+' L '+c+' A '+inside+' '+inside+' 0 '+large+' 0 '+d+' Z';
        const mark=svgNode('path',{d:path,fill:color(group.key,state.group),'fill-rule':'evenodd','data-chart-hit':'segment','aria-label':group.label+': '+prettyValue(state.share?amount/total*100:amount),opacity:state.selection && state.selection.group!==group.key?.35:1});
        mark.style.cursor='pointer';mark.onpointermove=event=>{const rect=svg.getBoundingClientRect();tip(group.label,[[metrics[state.metric].name,number(amount)+' '+metrics[state.metric].unit],['Participación',number(amount/total*100)+'%']],event.clientX-rect.left,event.clientY-rect.top);};mark.onclick=()=>pick(group.key);mark.onpointerleave=()=>{el('tooltip').hidden=true;};
      }
      svgText(number(total),cx,cy+2,{'text-anchor':'middle',class:'chart-value donut-value'});svgText(metrics[state.metric].unit,cx,cy+24,{'text-anchor':'middle'});
      previousGeometry=nextGeometry;return;
    }
    const margin={left:64,right:16,top:28,bottom:58},left=margin.left,right=width-margin.right,top=margin.top,bottom=height-margin.bottom,plotWidth=right-left,plotHeight=bottom-top,n=model.groups.length;
    const values=model.groups.map(group=>model.series.map(serie=>chartValue(model.cell(group.key,serie.key))));
    const oldValues=model.groups.map(group=>model.series.map(serie=>chartValue(model.cell(group.key,serie.key,true),true)));
    const totals=values.map(row=>row.reduce((sum,item)=>sum+(item||0),0));
    const maxValue=Math.max(0,...(state.chart==='stacked'?totals:values.flat().filter(item=>item!=null)),...(state.compare && model.coveredPrevious?oldValues.flat().filter(item=>item!=null):[]));
    const magnitude=Math.pow(10,Math.floor(Math.log10(maxValue||1))),maximum=Math.max(1,Math.ceil((maxValue||1)*1.14/magnitude)*magnitude);
    const y=value=>bottom-(value||0)/maximum*plotHeight,step=plotWidth/n,x=index=>left+step*(index+.5);
    for(let index=0;index<=4;index++){const amount=maximum*index/4,yy=y(amount);svgNode('line',{x1:left,y1:yy,x2:right,y2:yy,class:'grid-line'});svgText(number(amount),left-9,yy+4,{'text-anchor':'end'});}
    svgText(state.share?'Participación (%)':metrics[state.metric].unit,left,15,{class:'axis-title','data-axis':'y'});
    const tickNodes=[],tickCount=Math.min(n,width<420?4:7),ticks=new Set(Array.from({length:tickCount},(_,index)=>tickCount===1?0:Math.round(index*(n-1)/(tickCount-1))));
    for(const index of ticks){const group=model.groups[index],base=group.label;let text=base;if(!temporal() && text.length>(width<420?13:20))text=text.slice(0,width<420?11:18)+'…';tickNodes.push(svgText(text,x(index),bottom+24,{'text-anchor':index===0 && n>3?'start':index===n-1 && n>3?'end':'middle'}));}
    const measured=tickNodes.map(node=>node.getBBox()),kept=[];
    for(let index=0;index<tickNodes.length;index++){while(kept.length && measured[kept.at(-1)].x+measured[kept.at(-1)].width+4>measured[index].x){if(index===tickNodes.length-1){tickNodes[kept.pop()].setAttribute('visibility','hidden');}else{tickNodes[index].setAttribute('visibility','hidden');break;}}if(tickNodes[index].getAttribute('visibility')!=='hidden')kept.push(index);}
    svgText(state.group==='week'?'Semana (lunes)':groupNames[state.group],left+plotWidth/2,height-8,{'text-anchor':'middle',class:'axis-title','data-axis':'x'});
    svgNode('rect',{x:left,y:top,width:plotWidth,height:plotHeight,fill:'none',stroke:'var(--ca-line)','stroke-width':1,'data-chart-frame':''});
    const overlay=svgNode('rect',{x:left,y:top,width:plotWidth,height:plotHeight,fill:'transparent','data-chart-hit':'plot','data-chart-hover-overlay':'cross-series'});
    function pathData(points,area=false){let path='',started=false;for(const point of points){if(point.value==null){started=false;continue;}path+=(started?' L ':' M ')+point.x+' '+point.y;started=true;}if(area && points.every(point=>point.value!=null))path+=' L '+points.at(-1).x+' '+bottom+' L '+points[0].x+' '+bottom+' Z';return path;}
    function linePath(key,points,attributes,area=false){const node=svgNode('path',{d:pathData(points,area),...attributes}),before=previousGeometry.get(key);nextGeometry.set(key,{kind:'path',points});if(before?.kind==='path' && before.points.length && points.length && !reduce && points.length<90){const old=points.map((point,index)=>{const p=index*(before.points.length-1)/Math.max(1,points.length-1),a=before.points[Math.floor(p)],b=before.points[Math.ceil(p)],t=p-Math.floor(p);return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,value:point.value};});if(points.some((point,index)=>Math.abs(point.x-old[index].x)+Math.abs(point.y-old[index].y)>.2))transitions.push(t=>node.setAttribute('d',pathData(points.map((point,index)=>({...point,x:old[index].x+(point.x-old[index].x)*t,y:old[index].y+(point.y-old[index].y)*t})),area)));}return node;}
    if(state.chart==='bars' || state.chart==='stacked'){
      for(let index=0;index<n;index++){const group=model.groups[index],cluster=step*.72,barWidth=state.chart==='stacked'?cluster:cluster/Math.max(1,visible.length);let accumulated=0;
        for(let position=0;position<visible.length;position++){const serie=visible[position],amount=chartValue(model.cell(group.key,serie.key));if(amount==null || amount===0)continue;const xx=x(index)-cluster/2+(state.chart==='stacked'?0:position*barWidth),base=state.chart==='stacked'?accumulated:0;const mark=rectMark(JSON.stringify([state.chart,group.key,serie.key]),{x:xx,y:y(base+amount),width:Math.max(.15,barWidth-(n<35?2:0)),height:Math.max(0,y(base)-y(base+amount)),fill:serie.color,opacity:state.selection && (state.selection.group!==group.key || state.selection.series && state.selection.series!==serie.key)?.35:1,'data-chart-hit':'bar','aria-label':group.label+' · '+serie.label+': '+prettyValue(amount)});mark.style.cursor='pointer';mark.onclick=event=>{event.stopPropagation();pick(group.key,serie.key);};if(state.chart==='stacked')accumulated+=amount;}
      }
    }else{
      for(const serie of visible){const points=model.groups.map((group,index)=>{const amount=chartValue(model.cell(group.key,serie.key));return {x:x(index),y:y(amount),value:amount};});if(state.chart==='area')linePath('area-'+serie.key,points,{fill:serie.color,'fill-opacity':.14,stroke:'none'},true);linePath('line-'+serie.key,points,{fill:'none',stroke:serie.color,'stroke-width':2});if(n<=35)points.forEach((point,index)=>{if(point.value==null)return;const mark=svgNode('circle',{cx:point.x,cy:point.y,r:3.5,fill:serie.color,'data-chart-hit':'point','aria-label':model.groups[index].label+' · '+serie.label+': '+prettyValue(point.value)});mark.onclick=event=>{event.stopPropagation();pick(model.groups[index].key,serie.key);};});}
    }
    if(state.compare && model.coveredPrevious){for(const serie of visible){const column=model.series.findIndex(item=>item.key===serie.key),points=model.groups.map((group,index)=>({x:x(index),y:y(oldValues[index][column]),value:oldValues[index][column]}));linePath('previous-'+serie.key,points,{fill:'none',stroke:serie.color,'stroke-width':1.8,'stroke-dasharray':'6 4'});}}
    const guide=svgNode('line',{x1:left,x2:left,y1:top,y2:bottom,class:'guide','data-chart-hover-guide':'',visibility:'hidden'}),markers=svgNode('g',{'pointer-events':'none'});
    function pointer(event,select=false){const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)*width/rect.width,py=(event.clientY-rect.top)*height/rect.height;if(px<left || px>right || py<top || py>bottom){guide.setAttribute('visibility','hidden');el('tooltip').hidden=true;return;}const index=Math.max(0,Math.min(n-1,Math.floor((px-left)/step))),group=model.groups[index];
      if(select){const nearest=visible.map(serie=>({serie,distance:Math.abs(y(chartValue(model.cell(group.key,serie.key)))-py)})).sort((a,b)=>a.distance-b.distance)[0];pick(group.key,nearest?.serie.key);return;}
      guide.setAttribute('x1',String(px));guide.setAttribute('x2',String(px));guide.setAttribute('visibility','visible');markers.replaceChildren();const rows=[];
      const position=Math.max(0,Math.min(n-1,(px-x(0))/step)),a=Math.floor(position),b=Math.ceil(position),fraction=position-a,interpolated=(state.chart==='line'||state.chart==='area') && a!==b;
      for(const serie of visible){const first=chartValue(model.cell(model.groups[a].key,serie.key)),last=chartValue(model.cell(model.groups[b].key,serie.key)),amount=interpolated?(first==null || last==null?null:first+(last-first)*fraction):chartValue(model.cell(group.key,serie.key));rows.push([serie.label+(state.compare?' · actual':''),(interpolated?'≈ ':'')+prettyValue(amount)]);if(amount!=null)svgNode('circle',{cx:px,cy:y(amount),r:3,fill:serie.color,'data-chart-hover-marker':serie.key},markers);
        if(state.compare && model.coveredPrevious){const column=model.series.findIndex(item=>item.key===serie.key),oldFirst=oldValues[a][column],oldLast=oldValues[b][column],before=interpolated?(oldFirst==null || oldLast==null?null:oldFirst+(oldLast-oldFirst)*fraction):oldValues[index][column];rows.push([serie.label+' · anterior',(interpolated?'≈ ':'')+prettyValue(before)]);if(before!=null)svgNode('circle',{cx:px,cy:y(before),r:3,fill:serie.color,'fill-opacity':.5,'data-chart-hover-marker':'previous-'+serie.key},markers);}
      }
      tip(interpolated?model.groups[a].label+' → '+model.groups[b].label+' · interpolación':group.label,rows,px,py);
    }
    svg.onpointermove=event=>pointer(event);svg.onpointerleave=()=>{guide.setAttribute('visibility','hidden');markers.replaceChildren();el('tooltip').hidden=true;};overlay.onclick=event=>pointer(event,true);
    previousGeometry=nextGeometry;
    if(transitions.length){const started=performance.now();const animate=now=>{const amount=Math.min(1,(now-started)/200),eased=1-Math.pow(1-amount,3);transitions.forEach(apply=>apply(eased));if(amount<1)animationFrame=requestAnimationFrame(animate);};transitions.forEach(apply=>apply(0));animationFrame=requestAnimationFrame(animate);}
  }
    function clearReport(text='Cargando informe…') {
      model=null;previousGeometry=new Map();cancelAnimationFrame(animationFrame);
      for(const id of ['kpi-count','kpi-minutes','kpi-average'])el(id).textContent='—';
      for(const id of ['delta-count','delta-minutes','delta-average','consolidated','comparison','definition','coverage','aggregate-page','record-page','record-count','selection-label'])el(id).textContent='';
      el('svg').replaceChildren();el('svg').setAttribute('hidden','');el('tooltip').hidden=true;el('legend').replaceChildren();el('empty').hidden=false;el('empty').textContent=text;
      emptyRow('aggregate-rows',text,6);emptyRow('record-rows',text,6);
      for(const id of ['aggregate-prev','aggregate-next','record-prev','record-next','export-summary','export-records'])el(id).disabled=true;
    }
    async function ensureViews(force=false) {
      if(revision!==null && !force)return;
      if(viewPromise && !force)return viewPromise;
      const run=generation,promise=json('/v1/analytics/views').then(data=>{if(!active(run))return;revision=data.revision;library=data.library;renderViews();}).finally(()=>{if(viewPromise===promise)viewPromise=null;});
      viewPromise=promise;return promise;
    }
    async function load(nextCatalog) {
      if(!isActive())return;
      if(nextCatalog){catalog={devices:nextCatalog.devices||[],lines:nextCatalog.lines||[]};renderCatalog();}
      compatible();
      const run=generation,ticket=++serial,snapshot=reportState(),valid=()=>active(run)&&ticket===serial;
      root.setAttribute('aria-busy','true');
      const viewsWork=ensureViews().catch(error=>{if(active(run)){el('view-message').textContent='No se pudieron cargar las vistas. Actualiza la vista para volver a intentar.';onError(error);}});
      try {
        const data=await json(endpoint('/v1/analytics',snapshot));
        if(!valid())return;
        const serverToday=localDate(data.as_of);
        if(serverToday!==today){today=serverToday;if(state.preset!=='custom'&&!dirty){const dates=range(state.preset);if(dates.from!==state.from||dates.to!==state.to){Object.assign(state,dates);state.selection=null;state.recordPage=0;state.aggregatePage=0;syncDraft();return load();}}}
        if(data.detail.total && snapshot.offset>=data.detail.total){state.recordPage=Math.floor((data.detail.total-1)/state.size);return load();}
        if(!data.detail.total)state.recordPage=0;
        model=acceptReport(data);render();feedback();
      } catch(error) {if(valid()){clearReport('No se pudo cargar el informe. Actualiza la vista para volver a intentar.');feedback(error.message,true);onError(error);}}
      finally {if(valid())root.setAttribute('aria-busy','false');}
      await viewsWork;
    }
    function changed() {state.selection=null;state.aggregatePage=0;state.recordPage=0;feedback();compatible();clearReport();renderViews();return load();}
    function pick(group,series=null) {if(!model)return;state.selection={group,series};state.recordPage=0;el('records').open=true;el('clear-selection').hidden=false;el('selection-label').textContent=selectionLabel();emptyRow('record-rows','Cargando registros…',6);drawChart();return load();}
    function clearSelection() {state.selection=null;state.recordPage=0;if(model)drawChart();return load();}
    function showViewEditor(open){el('view-editor').hidden=!open;el('view-new').setAttribute('aria-expanded',String(open));el('view-error').textContent='';if(open){el('view-name').value='';el('view-name').focus();}}
    function renderViews() {
      el('views').replaceChildren();el('view-list').replaceChildren();el('view-save').disabled=viewBusy;el('view-new').disabled=viewBusy||revision===null;el('view-manage').disabled=viewBusy||revision===null;
      if(revision===null){const text=document.createElement('span');text.className='hint';text.textContent='Cargando vistas guardadas…';el('views').append(text);return;}
      const matches=allViews().filter(view=>JSON.stringify(viewConfig(normalizeConfig(view.config)))===JSON.stringify(viewConfig(state)));
      state.guide=(matches.find(view=>view.id===state.guide)||matches[0])?.id||'';
      for(const view of allViews()){
        const button=document.createElement('button');button.type='button';button.id='ca-guide-'+view.id;button.textContent=view.name;button.disabled=viewBusy;button.setAttribute('aria-pressed',String(state.guide===view.id));button.onclick=()=>{state={...normalizeConfig(view.config),guide:view.id,size:state.size};syncDraft();return changed();};el('views').append(button);
        const item=document.createElement('li'),label=document.createElement('span'),tag=document.createElement('small'),remove=document.createElement('button');label.textContent=view.name;tag.textContent=defaultIds.includes(view.id)?'Predeterminada':'Personalizada';label.append(tag);remove.type='button';remove.textContent='Eliminar';remove.disabled=viewBusy;remove.setAttribute('aria-label','Eliminar vista '+view.name);
        remove.onclick=()=>{const saved={...view,index:library.views.findIndex(item=>item.id===view.id)},next={hiddenDefaults:[...library.hiddenDefaults],views:[...library.views]};if(defaultIds.includes(view.id))next.hiddenDefaults.push(view.id);else next.views=next.views.filter(item=>item.id!==view.id);return persistLibrary(next,()=>{removedView=saved;el('view-message').textContent='Vista eliminada: '+view.name+'.';});};item.append(label,remove);el('view-list').append(item);
      }
      if(!allViews().length){const text=document.createElement('span');text.className='hint';text.textContent='No hay vistas guardadas. Guarda la configuración actual o restaura las predeterminadas.';el('views').append(text);}
      el('views-restore').disabled=viewBusy||!library.hiddenDefaults.length;el('view-undo').hidden=!removedView;el('view-undo').disabled=viewBusy;
    }
    async function persistLibrary(next,after) {
      if(viewBusy)return;
      const run=generation;viewBusy=true;renderViews();el('view-error').textContent='';
      try {const result=await json('/v1/analytics/views',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,library:next})});if(!active(run))return;revision=result.revision;library=result.library;after();renderViews();}
      catch(error){if(!active(run))return;if(error.status===409){try{await ensureViews(true);}catch(loadError){if(active(run))onError(loadError);}if(active(run))el('view-message').textContent='Las vistas cambiaron en otro navegador. Se actualizó la lista; vuelve a intentar la acción.';}else{el('view-error').textContent=error.message;el('view-message').textContent='No se pudo guardar el cambio. '+error.message;onError(error);}}
      finally{if(active(run)){viewBusy=false;renderViews();}}
    }
    function saveView() {
      const name=el('view-name').value.trim();
      if(!name){el('view-error').textContent='Escribe un nombre para esta vista.';el('view-name').focus();return;}
      if(name.length>50){el('view-error').textContent='El nombre admite hasta 50 caracteres.';return;}
      if([...defaultViews(),...library.views].some(view=>view.name.toLocaleLowerCase()===name.toLocaleLowerCase())){el('view-error').textContent='Ya existe una vista con ese nombre. Elige otro nombre.';return;}
      if(library.views.length>=16){el('view-error').textContent='Puedes guardar hasta 16 vistas. Elimina una para guardar otra.';return;}
      if(dirty){el('view-error').textContent='Aplica los filtros antes de guardar la vista.';return;}
      const view={id:'custom-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),name,config:viewConfig(state)};
      return persistLibrary({hiddenDefaults:[...library.hiddenDefaults],views:[...library.views,view]},()=>{state.guide=view.id;showViewEditor(false);el('view-message').textContent='Vista guardada: '+name+'.';});
    }
    function showViewManager(open){el('view-manager').hidden=!open;el('view-manage').setAttribute('aria-expanded',String(open));}
    function deactivate() {generation++;serial++;exportPending.summary=false;exportPending.records=false;cancelAnimationFrame(animationFrame);if(viewPromise||viewBusy)revision=null;viewPromise=null;viewBusy=false;root.setAttribute('aria-busy','false');el('tooltip').hidden=true;}
    function reset() {
      deactivate();seriesColors.clear();today=localDate(Date.now());state=defaults();catalog={devices:[],lines:[]};revision=null;library={hiddenDefaults:[],views:[]};removedView=null;dirty=false;
      el('views').replaceChildren();el('view-list').replaceChildren();el('device').replaceChildren(new Option('Todos los equipos',''));el('line').replaceChildren(new Option('Todas las líneas',''));
      el('view-editor').hidden=true;el('view-manager').hidden=true;el('view-name').value='';el('records').open=false;el('filters').open=false;
      for(const id of ['view-message','view-error','draft','filter-error','range','feedback'])el(id).textContent='';
      for(const kind of ['summary','records']){exportFormats[kind]='csv';el(kind+'-format').value='csv';}
      el('view-new').setAttribute('aria-expanded','false');el('view-manage').setAttribute('aria-expanded','false');el('view-undo').hidden=true;el('clear-selection').hidden=true;
      compatible();syncDraft();clearReport('Selecciona Analítica para cargar los registros recibidos.');
    }
    function applyFilters() {
      const from=el('from').value,to=el('to').value;
      if(!validDate(from)||!validDate(to)||from>to||from<el('from').min||to>el('to').max){el('filter-error').textContent='Revisa las fechas: Desde debe ser anterior o igual a Hasta y respetar el rango del calendario.';return;}
      Object.assign(state,{from,to,preset:el('period').value,device:el('device').value,line:el('line').value,type:el('type').value,guide:'',hiddenSeries:[],hiddenGroups:[]});syncDraft();return changed();
    }
    async function downloadData(kind) {
      if(!model || exportPending[kind])return;
      const run=generation,snapshot={...reportState(),selection:kind==='records'?state.selection:null},format=exportFormats[kind],button=el('export-'+kind),valid=()=>active(run);
      const filename='calllog-'+(kind==='summary'?'resumen':'detalle')+'-'+snapshot.from+'_'+snapshot.to+'.'+format;
      exportPending[kind]=true;button.disabled=true;feedback('Preparando '+(kind==='summary'?'resumen':'detalle')+' en '+(format==='xlsx'?'Excel':'CSV')+'…');
      try {await download(endpoint('/v1/analytics/export',snapshot)+'&kind='+kind+'&format='+format,filename,valid);if(valid())feedback('Archivo descargado con los filtros aplicados al solicitarlo. Incluye todas las páginas.');}
      catch(error){if(valid()){feedback('No se pudo descargar el archivo. '+error.message,true);onError(error);}}
      finally{if(run===generation){exportPending[kind]=false;button.disabled=!model;}}
    }

    el('view-new').addEventListener('click',()=>showViewEditor(el('view-editor').hidden));el('view-cancel').addEventListener('click',()=>showViewEditor(false));el('view-save').addEventListener('click',saveView);el('view-name').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveView();}});
    el('view-manage').addEventListener('click',()=>showViewManager(el('view-manager').hidden));el('view-manager-close').addEventListener('click',()=>showViewManager(false));
    el('views-restore').addEventListener('click',()=>persistLibrary({hiddenDefaults:[],views:[...library.views]},()=>{el('view-message').textContent='Vistas predeterminadas restauradas.';}));
    el('view-undo').addEventListener('click',()=>{if(!removedView)return;const standard=defaultIds.includes(removedView.id);if(!standard&&(library.views.length>=16||library.views.some(view=>view.name.toLocaleLowerCase()===removedView.name.toLocaleLowerCase()))){el('view-message').textContent='Elimina la vista con el mismo nombre o libera un lugar antes de deshacer.';return;}const next={hiddenDefaults:[...library.hiddenDefaults],views:[...library.views]};if(standard)next.hiddenDefaults=next.hiddenDefaults.filter(id=>id!==removedView.id);else next.views.splice(removedView.index,0,{id:removedView.id,name:removedView.name,config:removedView.config});return persistLibrary(next,()=>{removedView=null;el('view-message').textContent='Eliminación deshecha.';});});
    el('period').addEventListener('change',()=>{const preset=el('period').value;if(preset==='custom'){dirty=true;el('filters').open=true;el('from').focus();el('draft').textContent='Elige fechas y pulsa Aplicar filtros.';return;}Object.assign(state,{preset,...range(preset)});syncDraft();return changed();});
    for(const id of ['device','line','type','from','to'])el(id).addEventListener('change',()=>{if(id==='device')lineOptions('');if(id==='line'&&el('line').value&&el('line').value!=='unknown'){const selected=el('line').value;el('device').value=JSON.parse(selected)[0];lineOptions(selected);}if(id==='from'||id==='to')el('period').value='custom';dirty=true;el('draft').textContent='Hay cambios sin aplicar.';el('filter-error').textContent='';});
    el('apply').addEventListener('click',applyFilters);el('filter-form').addEventListener('submit',event=>{event.preventDefault();applyFilters();});
    for(const id of ['from','to'])el(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyFilters();}});
    el('reset').addEventListener('click',()=>{state=defaults();syncDraft();return changed();});
    for(const id of ['metric','group','breakdown','chart'])el(id).addEventListener('change',()=>{state[id]=el(id).value;state.guide='';if(id==='group'||id==='breakdown'){state.hiddenSeries=[];state.hiddenGroups=[];}return changed();});
    el('share').addEventListener('change',()=>{state.share=el('share').checked;return changed();});el('compare').addEventListener('change',()=>{state.compare=el('compare').checked;return changed();});
    el('aggregate-prev').addEventListener('click',()=>{if(!model)return;state.aggregatePage=Math.max(0,state.aggregatePage-1);renderAggregates();});el('aggregate-next').addEventListener('click',()=>{if(!model)return;state.aggregatePage++;renderAggregates();});
    el('record-prev').addEventListener('click',()=>{state.recordPage=Math.max(0,state.recordPage-1);return load();});el('record-next').addEventListener('click',()=>{state.recordPage++;return load();});el('size').addEventListener('change',()=>{state.size=Number(el('size').value);state.recordPage=0;return load();});el('clear-selection').addEventListener('click',clearSelection);
    for(const kind of ['summary','records']){el(kind+'-format').addEventListener('change',()=>{exportFormats[kind]=el(kind+'-format').value;});el('export-'+kind).addEventListener('click',()=>downloadData(kind));}
    reset();if(globalThis.ResizeObserver)new ResizeObserver(()=>{if(isActive())drawChart();}).observe(el('plot'));
    return {load,reset,deactivate};
  }
};
