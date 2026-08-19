// ─── COUNTRIES ────────────────────────────────────────────
const COUNTRIES=[
  {flag:'🇮🇳',name:'India',code:'+91'},
  {flag:'🇺🇸',name:'United States',code:'+1'},
  {flag:'🇬🇧',name:'United Kingdom',code:'+44'},
  {flag:'🇦🇺',name:'Australia',code:'+61'},
  {flag:'🇨🇦',name:'Canada',code:'+1'},
  {flag:'🇩🇪',name:'Germany',code:'+49'},
  {flag:'🇫🇷',name:'France',code:'+33'},
  {flag:'🇯🇵',name:'Japan',code:'+81'},
  {flag:'🇰🇷',name:'South Korea',code:'+82'},
  {flag:'🇧🇷',name:'Brazil',code:'+55'},
  {flag:'🇷🇺',name:'Russia',code:'+7'},
  {flag:'🇨🇳',name:'China',code:'+86'},
  {flag:'🇿🇦',name:'South Africa',code:'+27'},
  {flag:'🇦🇪',name:'UAE',code:'+971'},
  {flag:'🇸🇬',name:'Singapore',code:'+65'},
  {flag:'🇲🇾',name:'Malaysia',code:'+60'},
  {flag:'🇵🇰',name:'Pakistan',code:'+92'},
  {flag:'🇧 Bangladesh',name:'Bangladesh',code:'+880'},
  {flag:'🇮🇩',name:'Indonesia',code:'+62'},
  {flag:'🇵🇭',name:'Philippines',code:'+63'},
  {flag:'🇳🇬',name:'Nigeria',code:'+234'},
  {flag:'🇲🇽',name:'Mexico',code:'+52'},
  {flag:'🇦🇷',name:'Argentina',code:'+54'},
  {flag:'🇮🇹',name:'Italy',code:'+39'},
  {flag:'🇪🇸',name:'Spain',code:'+34'},
];

let selectedCountry = COUNTRIES[0];

function buildCountryList(list){
  const el=document.getElementById('cd-list'); if(!el)return;
  el.innerHTML='';
  list.forEach(c=>{
    const row=document.createElement('div'); row.className='cd-item';
    row.innerHTML=`<span class="flag">${c.flag}</span><span class="name">${c.name}</span><span class="code">${c.code}</span>`;
    row.onclick=e=>{e.stopPropagation();selectCountry(c);};
    el.appendChild(row);
  });
}

function filterCountries(){
  const q=document.getElementById('cd-search-input').value.toLowerCase();
  buildCountryList(COUNTRIES.filter(c=>c.name.toLowerCase().includes(q)||c.code.includes(q)));
}

function selectCountry(c){
  selectedCountry=c;
  document.getElementById('sel-flag').textContent=c.flag;
  document.getElementById('sel-code').textContent=c.code;
  closeDropdown();
}

function toggleDropdown(e){
  e.stopPropagation();
  const dd=document.getElementById('country-dropdown');
  const ch=document.getElementById('sel-chevron');
  const open=dd.classList.contains('open');
  if(open){dd.classList.remove('open');ch.classList.remove('open');}
  else{dd.classList.add('open');ch.classList.add('open');setTimeout(()=>document.getElementById('cd-search-input').focus(),80);}
}

function closeDropdown(){
  const dd=document.getElementById('country-dropdown');
  if(dd){
    dd.classList.remove('open');
    document.getElementById('sel-chevron').classList.remove('open');
    document.getElementById('cd-search-input').value='';
    buildCountryList(COUNTRIES);
  }
}

window.COUNTRIES = COUNTRIES;
window.selectedCountry = selectedCountry;
window.buildCountryList = buildCountryList;
window.filterCountries = filterCountries;
window.selectCountry = selectCountry;
window.toggleDropdown = toggleDropdown;
window.closeDropdown = closeDropdown;
