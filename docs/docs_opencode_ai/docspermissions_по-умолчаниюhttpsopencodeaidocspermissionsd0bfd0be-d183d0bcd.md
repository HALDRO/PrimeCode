<!-- Source: https://opencode.ai/docs/permissions -->

## [По умолчанию](https://opencode.ai/docs/permissions#%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E)
Если вы ничего не укажете, opencode запустится с разрешенных значений по умолчанию:
  * Большинство разрешений по умолчанию имеют значение `"allow"`.
  * `doom_loop` и `external_directory` по умолчанию равны `"ask"`.
  * `read` — это `"allow"`, но файлы `.env` по умолчанию запрещены:


opencode.json```

{



"permission": {




"read": {




"*": "allow",




"*.env": "deny",




"*.env.*": "deny",




"*.env.example": "allow"



}


}


}

```

* * *

