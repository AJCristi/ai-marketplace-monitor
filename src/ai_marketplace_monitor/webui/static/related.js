import {safeUrl, matchPhotoUrl} from './console-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={reused_photo:'Reused photo',possible_same_item:'Possibly the same item',matching_plate:'Matching plate'};
const photo=row=>matchPhotoUrl(row)?`<img src="${esc(matchPhotoUrl(row))}" alt="${esc(row.title||'Listing photo')}" loading="lazy" referrerpolicy="no-referrer">`:'<span>Saved photo unavailable</span>';
export function relatedHtml(row,data={}) {
  const running=['queued','running'].includes(data.job?.state), check=data.last_check;
  const failed=check&&['error','skipped'].includes(check.status);
  const result=(data.related||[]).map(pair=>{
    const other=pair.other||{}, url=safeUrl(other.url);
    return `<article class="related-pair"><h4>${esc(labels[pair.decision]||'Possible connection')} · ${esc(pair.review)}</h4><div class="related-photos"><figure>${photo(pair.source||row)}<figcaption>This listing</figcaption></figure><figure>${photo(other)}<figcaption>${esc(other.title||'Related listing')}</figcaption></figure></div><p class="xs d">${pair.stale?'The source photo changed. Recheck this connection. ':''}Evidence checked ${esc(pair.checked_at||'previously')}.</p><p class="sm">${esc(other.seller||'Unknown seller')} · ${esc(other.price||'Unknown price')}</p><ul class="sm">${(pair.evidence||[]).map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open related listing ↗</a>`:''}<div class="row wr"><button class="btn" data-pair="${esc(pair.pair_id)}" data-review="confirmed" aria-pressed="${pair.review==='confirmed'}">Confirm connection</button><button class="btn q" data-pair="${esc(pair.pair_id)}" data-review="${pair.review==='dismissed'?'unreviewed':'dismissed'}">${pair.review==='dismissed'?'Restore connection':'Dismiss connection'}</button></div></article>`;
  }).join('');
  return `<h3>Related listings</h3><p class="sm d">Checks saved primary photos for reused images, distinctive details and matching plates. Suggestions do not establish ownership or fraud.</p><div class="row wr"><button class="btn" data-find-related ${running?'disabled':''}>${running?'Checking photos…':'Find related listings'}</button>${check?`<button class="btn q" data-find-related="refresh" ${running?'disabled':''}>Recheck</button>`:''}<a href="#/settings/more">Image matching settings</a></div><p class="sm" role="status">${data.error?esc(data.error):running?`Image matching ${esc(data.job.state)}${data.job.candidates!=null?` · ${data.job.compared||0} of ${data.job.candidates} candidates`:""}. Searches take priority.`:check?`${failed?esc(check.reason):`Checked ${check.compared||0} candidate listings. ${result?'':'No connections flagged among those candidates.'}`}`:'Not checked yet.'}</p>${data.budget?`<p class="xs d">Automatic checks ${data.budget.automatic?'on':'off'} · estimated usage $${Number(data.budget.used_usd).toFixed(4)} / $${Number(data.budget.limit_usd).toFixed(2)} today (UTC).</p>`:''}${result}`;
}

export function createRelatedView({json,toast}) {
  let current=null, revision=0, busy=false, data={};
  const path=row=>`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/related`;
  function draw(){
    if(!current)return;
    const html=relatedHtml(current.row,data);
    if(current.container.innerHTML===html)return;
    const focused=typeof document==='undefined'?null:document.activeElement;
    const restore=focused&&current.container.contains(focused)?{find:focused.getAttribute('data-find-related'),pair:focused.dataset.pair,review:focused.dataset.review}:null;
    current.container.innerHTML=html;
    if(restore){
      const replacement=[...current.container.querySelectorAll('button')].find(button=>restore.pair?button.dataset.pair===restore.pair&&button.dataset.review===restore.review:restore.find!==null&&button.getAttribute('data-find-related')===restore.find);
      if(replacement&&!replacement.disabled)replacement.focus({preventScroll:true});
    }
    current.container.querySelectorAll('img').forEach(img=>{img.onerror=()=>{img.alt='Photo unavailable';img.removeAttribute('src');};});
  }
  async function refresh(){
    if(!current||busy)return;
    const snapshot=current, ticket=revision;
    busy=true;
    try{const result=await json(path(snapshot.row));if(ticket===revision){data=result;draw();}}
    catch(error){if(ticket===revision){data={...data,error:error.message};draw();}}
    finally{if(ticket===revision)busy=false;}
  }
  function mount(container,row){
    revision++;busy=false;data={};current={container,row};draw();
    container.onclick=async event=>{
      const button=event.target.closest('button');if(!button||button.disabled||busy)return;
      const ticket=revision;
      busy=true;button.disabled=true;
      try{
        if(button.hasAttribute('data-find-related')){
          await json(path(row),{method:'POST',body:JSON.stringify({refresh:button.dataset.findRelated==='refresh'})});
        }else if(button.dataset.pair){
          await json(path(row)+'/'+encodeURIComponent(button.dataset.pair),{method:'PUT',body:JSON.stringify({review:button.dataset.review})});
        }
        if(ticket===revision){busy=false;await refresh();}
      }catch(error){if(ticket===revision){data={...data,error:error.message};draw();toast(error.message);}}
      finally{if(ticket===revision){busy=false;button.disabled=false;}}
    };
    refresh();
  }
  function unmount(){revision++;current=null;busy=false;}
  return {mount,refresh,unmount};
}
