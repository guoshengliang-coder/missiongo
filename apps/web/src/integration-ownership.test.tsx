import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from './i18n';
import {IntegrationProgress} from './integration-details';
import type {Batch} from './merge-console';
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null}});
it('AND-520 keeps current handover blockers and extra publication responsibilities visible in the original batch',()=>{
  const batch:Batch={id:'batch',sessionId:'session',state:'active',publish:true,deliveries:['selected'],results:{selected:{status:'merged',detail:'Synthetic'}},presentation:{entries:{selected:{title:'Selected change',summary:'Synthetic',pullRequestUrl:'https://github.com/example/project/pull/1',requiredArtifacts:[],publication:'not_required',handover:{pending:true,blocker:'原批次仍须提交交接证据'},releases:[]}},ownedExtras:[{id:'extra',title:'额外发布范围',pendingArtifacts:['macosApp'],publication:'unknown',blocker:'额外交付授权已变化'}]}};
  const markup=renderToStaticMarkup(<I18nProvider><IntegrationProgress batch={batch}/></I18nProvider>);
  expect(markup).toContain('待交接');expect(markup).toContain('原批次仍须提交交接证据');expect(markup).toContain('额外发布范围');expect(markup).toContain('额外交付授权已变化');
});
