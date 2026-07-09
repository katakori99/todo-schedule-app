# ToDo親子構造: Supabase SQL実行手順

## この作業で行うこと

既存の`todo_items`へ、子タスクを表す`parent_id`を追加します。

- 既存ToDoの本文、完了状態、並び順は変更しません。
- 既存行の`parent_id`は自動的に`null`となり、これまでどおり親タスクとして扱われます。
- 現在公開中のアプリは追加列を使用しないため、SQL実行直後もそのまま動作します。
- Supabase Auth、既存RLS、時間割、Noteは変更しません。

実行SQL:

[`supabase/todo-hierarchy.sql`](../supabase/todo-hierarchy.sql)

## SQLに含まれる変更

1. `todo_items.parent_id`の追加
2. 親削除時に子も削除する自己参照外部キー
3. 親ごとの並び順を検索するインデックス
4. 同一ユーザーかつ1階層だけを許可する検証トリガー
5. 子タスク追加RPC `add_todo_child`
6. 親子の完了状態更新RPC `set_todo_item_done`
7. 同一階層内の並べ替えRPC `reorder_todo_siblings`
8. RPCの実行権限を`authenticated`だけに限定

RPCは`security invoker`で動作し、既存RLSを通過します。加えて各RPC内でも`auth.uid()`と所有者を確認します。

## 実行前の確認

次の条件を確認してください。

- Supabase Dashboardで対象プロジェクトを開いている
- Project URLが`https://hzaxnxokrfhcmrvocure.supabase.co`
- SQL Editorを開いている
- 公開アプリで重要な保存操作を実行中ではない

プロジェクトを間違えないことが最重要です。

## 手順1: SQL Editorを開く

1. [Supabase Dashboard](https://supabase.com/dashboard)を開きます。
2. 対象プロジェクトを開きます。
3. 左側メニューの`SQL Editor`を開きます。
4. `New query`を押します。
5. 分かりやすい名前を付ける場合は`todo hierarchy migration`とします。

## 手順2: SQLを貼り付ける

[`supabase/todo-hierarchy.sql`](../supabase/todo-hierarchy.sql)を開き、先頭の`begin;`から末尾の`commit;`までをすべてSQL Editorへ貼り付けます。

一部分だけ実行しないでください。全処理を1つのトランザクションとして実行します。

## 手順3: 実行する

1. SQL全体が貼り付けられていることを確認します。
2. 右下または上部の`Run`を1回だけ押します。
3. 完了するまで画面を閉じません。

成功時は`Success. No rows returned`に近い表示になります。結果表示の文言はDashboardの更新により多少異なる場合があります。

エラーが出た場合は、繰り返し`Run`を押さず、エラー全文をそのままCodexへ送ってください。`begin`から`commit`までの途中で失敗した場合、変更全体がロールバックされます。

## 手順4: 構造を確認する

新しい`New query`を開き、次の確認SQLだけを実行します。

```sql
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'todo_items'
  and column_name = 'parent_id';

select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.todo_items'::regclass
  and conname = 'todo_items_parent_id_fkey';

select
  trigger_name,
  event_manipulation
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'todo_items'
  and trigger_name in (
    'todo_items_validate_parent_insert',
    'todo_items_validate_parent_update'
  )
order by trigger_name;

select
  routine_name,
  security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'add_todo_child',
    'set_todo_item_done',
    'reorder_todo_siblings'
  )
order by routine_name;
```

## 正常な確認結果

次の状態なら完了です。

- `parent_id`が1行表示される
- `data_type`が`uuid`
- `is_nullable`が`YES`
- 外部キー`todo_items_parent_id_fkey`が1行表示される
- 検証トリガーが2行表示される
- RPCが3行表示される
- RPCの`security_type`がすべて`INVOKER`

## 既存データが変わっていないことの確認

必要なら次も実行できます。

```sql
select
  count(*) as all_todos,
  count(*) filter (where parent_id is null) as root_todos,
  count(*) filter (where parent_id is not null) as child_todos
from public.todo_items;
```

フロント実装前は、通常次の状態になります。

```text
all_todos = root_todos
child_todos = 0
```

## 実行後

確認結果が正常なら、Codexへ次の一文を送ってください。

```text
SQL完了
```

その後、CodexがToDo親子表示、折りたたみ、子タスク追加、完了同期、並べ替えを実装します。

## 注意事項

- SQL EditorへパスワードやAPIキーを貼り付ける必要はありません。
- `secret`キーや`service_role`キーは使用しません。
- 手動で`parent_id`へ値を入力しないでください。
- この段階では公開アプリに子タスク操作はまだ表示されません。
- SQL実行後に列だけを手動削除しないでください。

設計はSupabase公式のRLSおよびDatabase Functionsの指針に従い、RLSを有効なまま使用し、RPC実行権限を`authenticated`へ限定しています。

## 公式資料

- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: Database Functions](https://supabase.com/docs/guides/database/functions)
