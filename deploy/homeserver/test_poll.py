import unittest
from unittest.mock import patch
import poll
from poll import green_run,replacement,REPO

class GateTests(unittest.TestCase):
    def valid(self,**overrides):
        return dict(id=1,head_sha='a'*40,head_branch='main',event='push',path='.github/workflows/ci.yml',
                    head_repository={'full_name':REPO},status='completed',conclusion='success',**overrides)
    def test_only_green_main_push(self):
        valid=self.valid();self.assertEqual(green_run([valid],'a'*40),valid)
        for key,value in [('event','pull_request'),('head_branch','feature'),('conclusion','failure'),('status','in_progress'),('head_repository',{'full_name':'untrusted/fork'}),('path','other.yml')]:
            self.assertIsNone(green_run([dict(valid,**{key:value})],'a'*40))
        self.assertIsNone(green_run([valid],'b'*40))
    def test_failed_latest_rerun_blocks(self):
        valid=self.valid();self.assertIsNone(green_run([valid,dict(valid,id=2,conclusion='failure')],'a'*40))
        self.assertIsNone(green_run([valid,dict(valid,run_attempt=2,conclusion='failure')],'a'*40))
    def test_replace_web_only_and_keep_config(self):
        source='name: karakeep\nservices:\n  web:\n    image: old\n    env_file: [.env]\n  local-catalog:\n    image: local-old\n'
        result=replacement(source,'new')
        self.assertEqual(result,source.replace('image: old','image: new'))
        with self.assertRaises(RuntimeError):replacement('services: {}','new')
        with self.assertRaises(RuntimeError):replacement('services:\n  web:\n    build: .\n  local-catalog:\n    image: old\n','new')
    def test_cutover_rechecks_ci_before_any_mutation(self):
        with patch.object(poll,'head',return_value='a'*40), patch.object(poll,'api',return_value={'workflow_runs':[dict(self.valid(),conclusion='failure')]}), patch.object(poll,'run') as command:
            with self.assertRaisesRegex(RuntimeError,'ci_not_green'):poll.cutover('a'*40,'unused',None)
            command.assert_not_called()

    def test_restore_attempts_sidecar_even_when_web_is_missing(self):
        def state(name):
            if name==poll.WEB:raise RuntimeError('missing')
            return {'State':{'Running':False}}
        with patch.object(poll,'inspect',side_effect=state),patch.object(poll,'run') as command:
            with self.assertRaisesRegex(RuntimeError,'restore_failed'):poll.resume_services([poll.SIDECAR,poll.WEB])
            command.assert_called_once_with(['docker','start',poll.SIDECAR])

if __name__=='__main__':unittest.main()
