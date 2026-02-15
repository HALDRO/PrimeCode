<!-- Source: https://opencode.ai/docs/ru/sdk -->

## [Ошибки](https://opencode.ai/docs/ru/sdk#%D0%BE%D1%88%D0%B8%D0%B1%D0%BA%D0%B8)
SDK может выдавать ошибки, которые вы можете отловить и обработать:
```


try {




await client.session.get({ path: { id: "invalid-id" } })




} catch (error) {




console.error("Failed to get session:", (error asError).message)



}

```

* * *

