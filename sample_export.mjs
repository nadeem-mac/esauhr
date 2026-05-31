import XLSX from 'xlsx-js-style';

const GREEN='0F4C2A';
const year=2026, month=4; // May (0-indexed)
const monthLabel='May 2026';
const lastDay=new Date(year,month+1,0).getDate();
const days=[]; for(let d=1;d<=lastDay;d++) days.push(new Date(year,month,d));
const ymd=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// sample staff grouped by location
const grouped=[
 {location:'DMM',employees:[
   {id:'H94972',name:'Syed Ahamed', shift:'20:00-08:00', off:[5]},      // night, off Fri
   {id:'H94397',name:'Ahmad Elsharkawy', shift:'08:00-16:00', off:[5,6], mawani:[3,10,17,24]}, // Mawani some days
 ]},
 {location:'JED',employees:[
   {id:'H94226',name:'Sonnie Habal', shift:'09:00-17:00', off:[5,6]},
   {id:'H94555',name:'Omar Khan', shift:'23:00-07:00', off:[6]},        // overnight
 ]},
];

const cellLabel=(s)=>{ if(!s) return ''; const st=s.slice(0,5),en=s.slice(6,11)||s.split('-')[1]; if(!st||!en) return ''; return st>en?`${st}\u2192${en}`:`${st}-${en}`; };

const dayHdr=days.map(d=>`${d.getDate()}\n${d.toLocaleDateString('en-GB',{weekday:'short'})}`);
const headers=['Location','PSN','Employee',...dayHdr,'Shifts'];
const aoa=[[`STAFF SHIFT SCHEDULE \u2014 ${monthLabel}`],[],headers];
const rowKind=['title','blank','header'];

grouped.forEach(({location,employees})=>{
  employees.forEach(emp=>{
    let count=0;
    const dayCells=days.map(d=>{
      const wd=d.getDay(); const dom=d.getDate();
      // simple sample logic: shift on working days unless OFF; mawani days override
      if(emp.mawani && emp.mawani.includes(dom)){count++;return 'MAWANI';}
      if(emp.off && emp.off.includes(wd)) return 'OFF';
      count++; return cellLabel(emp.shift);
    });
    aoa.push([location,emp.id,emp.name,...dayCells,count]);
    rowKind.push('data');
  });
});
aoa.push([]); aoa.push(['Please review your staff and update their shifts for the next month in this same format.']);
rowKind.push('blank'); rowKind.push('note');

const ws=XLSX.utils.aoa_to_sheet(aoa);
const lastCol=headers.length-1, dayStart=3, dayEnd=3+days.length-1;
const isWeekendCol=(C)=>{ if(C<dayStart||C>dayEnd) return false; const wd=days[C-dayStart].getDay(); return wd===5||wd===6; };
const border={top:{style:'thin',color:{rgb:'E5E7EB'}},bottom:{style:'thin',color:{rgb:'E5E7EB'}},left:{style:'thin',color:{rgb:'E5E7EB'}},right:{style:'thin',color:{rgb:'E5E7EB'}}};
const range=XLSX.utils.decode_range(ws['!ref']);
for(let R=range.s.r;R<=range.e.r;R++){for(let C=range.s.c;C<=range.e.c;C++){const addr=XLSX.utils.encode_cell({r:R,c:C});if(!ws[addr])continue;const kind=rowKind[R];
 if(kind==='title') ws[addr].s={font:{bold:true,sz:14,color:{rgb:GREEN}}};
 else if(kind==='note') ws[addr].s={font:{sz:10,color:{rgb:'0A0A0A'}}};
 else if(kind==='header') ws[addr].s={font:{bold:true,sz:9,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:isWeekendCol(C)?'0A3A20':GREEN}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border};
 else if(kind==='data'){const v=ws[addr].v;const isDay=C>=dayStart&&C<=dayEnd;
   ws[addr].s={font:{sz:9,color:{rgb:v==='OFF'?'1D4ED8':(v==='MAWANI'?'854F0B':'0A0A0A')},bold:isDay&&v&&v!=='OFF'},
     fill:v==='OFF'?{fgColor:{rgb:'DBEAFE'}}:(v==='MAWANI'?{fgColor:{rgb:'FEF3C7'}}:(isWeekendCol(C)?{fgColor:{rgb:'F3F4F6'}}:undefined)),
     alignment:{horizontal:C<dayStart?'left':'center',vertical:'center'},border};}
}}
ws['!cols']=[{wch:12},{wch:9},{wch:24},...days.map(()=>({wch:7})),{wch:7}];
ws['!rows']=[{hpt:20},{},{hpt:28}];
ws['!freeze']={xSplit:3,ySplit:3};
ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:lastCol}}];
const wb=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb,ws,monthLabel);
XLSX.writeFile(wb,'/home/claude/STAFF_SHIFTS_May_2026.xlsx');
console.log('written; cols:',headers.length,'rows:',aoa.length);
